import json
from importlib.util import find_spec
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

if any(find_spec(name) is None for name in ["onnxruntime", "tokenizers", "huggingface_hub"]):
    pytest.skip("Install the encoder extra", allow_module_level=True)

from review_rank.encoder import DIMENSION, Encoder  # noqa: E402


class Tokens:
    def encode(self, text, add_special_tokens=False):
        return SimpleNamespace(ids=list(range(len(text.split()))))

    def token_to_id(self, name):
        return {"[CLS]": 101, "[SEP]": 102, "[PAD]": 0}[name]


class Session:
    def __init__(self):
        self.batch_shapes = []

    def get_inputs(self):
        return [SimpleNamespace(name=name) for name in ["input_ids", "attention_mask"]]

    def run(self, outputs, inputs):
        mask = inputs["attention_mask"]
        self.batch_shapes.append(mask.shape)
        tokens = np.ones((*mask.shape, DIMENSION))
        tokens[mask == 0] = 1e6
        return [tokens]


@pytest.mark.parametrize(
    "words,max_chunks,chunks,truncated",
    [
        (0, 16, 1, False),
        (254, 16, 1, False),
        (255, 16, 2, False),
        (4064, 16, 16, False),
        (4065, 16, 16, True),
        (5000, 128, 20, False),
        (32512, 128, 128, False),
        (32513, 128, 128, True),
    ],
)
def test_chunking_masks_padding_and_reports_truncation(words, max_chunks, chunks, truncated):
    encoder = Encoder.__new__(Encoder)
    encoder.tokenizer, encoder.session = Tokens(), Session()
    encoder.max_chunks, encoder.batch_chunks = max_chunks, 16
    vector, audit = encoder.encode("word " * words)
    assert len(vector) == DIMENSION
    assert np.linalg.norm(vector) == pytest.approx(1)
    assert audit == {"chunks": chunks, "truncated": truncated, "available_tokens": words}
    assert all(batch <= 16 and width <= 256 for batch, width in encoder.session.batch_shapes)
    json.dumps(vector, allow_nan=False)


class VariedSession(Session):
    def run(self, outputs, inputs):
        tokens = super().run(outputs, inputs)[0]
        tokens[:, :, 0] = inputs["input_ids"] / 1000
        tokens[:, :, 1] = inputs["input_ids"] % 13 / 13
        return [tokens]


@pytest.mark.parametrize("batch_chunks", [1, 3, 16])
def test_batching_preserves_equal_chunk_weight_and_ignores_padding(batch_chunks):
    encoder = Encoder.__new__(Encoder)
    encoder.tokenizer, encoder.session = Tokens(), VariedSession()
    encoder.max_chunks, encoder.batch_chunks = 128, batch_chunks
    vector, _ = encoder.encode("word " * 5000)
    expected = np.ones(DIMENSION)
    chunks = [np.array([101, *range(i, min(i + 254, 5000)), 102]) for i in range(0, 5000, 254)]
    expected[0] = np.mean([chunk.mean() / 1000 for chunk in chunks])
    expected[1] = np.mean([(chunk % 13 / 13).mean() for chunk in chunks])
    expected /= np.linalg.norm(expected)
    np.testing.assert_allclose(vector, expected, rtol=1e-12, atol=1e-12)
    assert all(batch <= batch_chunks for batch, _ in encoder.session.batch_shapes)


def test_longer_limit_includes_tokens_beyond_the_original_cutoff():
    encoder = Encoder.__new__(Encoder)
    encoder.tokenizer, encoder.session = Tokens(), VariedSession()
    encoder.max_chunks, encoder.batch_chunks = 16, 16
    short, short_audit = encoder.encode("word " * 5000)
    encoder.max_chunks = 128
    long, long_audit = encoder.encode("word " * 5000)
    assert not np.allclose(short, long)
    assert short_audit["truncated"] and not long_audit["truncated"]


def test_character_limit_is_reported_even_with_few_tokens():
    encoder = Encoder.__new__(Encoder)
    encoder.tokenizer, encoder.session = Tokens(), Session()
    encoder.max_chunks, encoder.batch_chunks = 128, 16
    _, audit = encoder.encode("x" * 2_000_001)
    assert audit == {"chunks": 1, "truncated": True, "available_tokens": 1}


@pytest.mark.parametrize(
    "settings",
    [{"max_chunks": value} for value in [0, -1, 129, True, 1.5]]
    + [{"batch_chunks": value} for value in [0, -1, 17, True, 1.5]],
)
def test_invalid_limits_fail_before_loading_model_files(settings):
    with pytest.raises(ValueError):
        Encoder(Path("unused"), **settings)
