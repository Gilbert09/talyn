import json
from importlib.util import find_spec
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
    def get_inputs(self):
        return [SimpleNamespace(name=name) for name in ["input_ids", "attention_mask"]]

    def run(self, outputs, inputs):
        mask = inputs["attention_mask"]
        tokens = np.ones((*mask.shape, DIMENSION))
        tokens[mask == 0] = 1e6
        return [tokens]


@pytest.mark.parametrize(
    "words,chunks,truncated", [(0, 1, False), (255, 2, False), (5000, 16, True)]
)
def test_chunking_masks_padding_and_reports_truncation(words, chunks, truncated):
    encoder = Encoder.__new__(Encoder)
    encoder.tokenizer, encoder.session = Tokens(), Session()
    vector, audit = encoder.encode("word " * words)
    assert len(vector) == DIMENSION
    assert np.linalg.norm(vector) == pytest.approx(1)
    assert audit == {"chunks": chunks, "truncated": truncated}
    json.dumps(vector, allow_nan=False)
