"""Encode observed content locally with fixed MiniLM weights."""

import argparse
import hashlib
import json
import os
from pathlib import Path

import numpy as np

from .outcomes import digest, write_private

# These settings must precede runtime initialization.
os.environ["ORT_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"

import onnxruntime as ort  # noqa: E402
from huggingface_hub import hf_hub_download  # noqa: E402
from tokenizers import Tokenizer  # noqa: E402

ort.disable_telemetry_events()

MODEL = "sentence-transformers/all-MiniLM-L6-v2"
REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
DIMENSION = 384


class Encoder:
    def __init__(self, cache: Path, download: bool = False):
        paths = [
            Path(
                hf_hub_download(
                    MODEL,
                    name,
                    revision=REVISION,
                    cache_dir=cache,
                    local_files_only=not download,
                    token=False,
                )
            )
            for name in ["tokenizer.json", "onnx/model.onnx"]
        ]
        self.provenance = {
            "model": MODEL,
            "revision": REVISION,
            "dimension": DIMENSION,
            "files_sha256": [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths],
            "pooling": "masked token mean, chunk mean, L2 normalization",
            "max_tokens": 256,
            "max_chunks": 16,
        }
        self.tokenizer = Tokenizer.from_file(str(paths[0]))
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(paths[1]), sess_options=options, providers=["CPUExecutionProvider"]
        )

    def encode(self, text: str) -> tuple[list[float], dict]:
        ids = self.tokenizer.encode(text[:2_000_000], add_special_tokens=False).ids
        truncated = len(ids) > 254 * 16 or len(text) > 2_000_000
        ids = ids[: 254 * 16]
        chunks = [ids[i : i + 254] for i in range(0, len(ids), 254)] or [[]]
        cls, sep, pad = [self.tokenizer.token_to_id(name) for name in ["[CLS]", "[SEP]", "[PAD]"]]
        if any(value is None for value in [cls, sep, pad]):
            raise ValueError("Unexpected tokenizer")
        width = max(len(chunk) for chunk in chunks) + 2
        token_ids = np.full((len(chunks), width), pad, dtype=np.int64)
        mask = np.zeros_like(token_ids)
        for i, chunk in enumerate(chunks):
            token_ids[i, : len(chunk) + 2] = [cls, *chunk, sep]
            mask[i, : len(chunk) + 2] = 1
        inputs = {
            "input_ids": token_ids,
            "attention_mask": mask,
            "token_type_ids": np.zeros_like(token_ids),
        }
        output = self.session.run(
            None, {item.name: inputs[item.name] for item in self.session.get_inputs()}
        )[0]
        pooled = (output * mask[:, :, None]).sum(axis=1) / mask.sum(axis=1)[:, None]
        vector = pooled.mean(axis=0)
        vector /= max(np.linalg.norm(vector), 1e-12)
        if vector.shape != (DIMENSION,) or not np.isfinite(vector).all():
            raise ValueError("Invalid encoder output")
        return vector.tolist(), {"truncated": truncated, "chunks": len(chunks)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--content", type=Path, nargs="+", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=Path("artifacts/encoder-cache"))
    parser.add_argument("--download-model", action="store_true")
    args = parser.parse_args()
    encoder = Encoder(args.cache, args.download_model)
    records, cache = [], {}
    for path in args.content:
        payload = json.loads(path.read_text())
        if payload.get("schema_version") != 1:
            raise ValueError("Expected a version 1 content file")
        for row in payload["records"]:
            if digest(row["text"]) != row["text_sha256"]:
                raise ValueError("Content hash mismatch")
            key = row["text_sha256"]
            if key not in cache:
                cache[key] = encoder.encode(row["text"])
            vector, audit = cache[key]
            records.append(
                {
                    **{k: v for k, v in row.items() if k != "text"},
                    "vector": vector,
                    "encoding": audit,
                }
            )
    write_private(
        args.output, {"schema_version": 1, "encoder": encoder.provenance, "records": records}
    )
    print(json.dumps({"encoded_records": len(records), "unique_texts": len(cache)}))


if __name__ == "__main__":
    main()
