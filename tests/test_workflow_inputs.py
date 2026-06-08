from __future__ import annotations

import base64
from pathlib import Path

from workflow_inputs import prepare_local_workflow_inputs


def test_prepare_local_workflow_inputs_normalizes_clipspace_suffix(
    tmp_path: Path,
) -> None:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output" / "clipspace"
    input_dir.mkdir()
    output_dir.mkdir(parents=True)

    (input_dir / "portrait.png").write_bytes(b"portrait-bytes")
    (output_dir / "mask.png").write_bytes(b"mask-bytes")

    workflow: dict[str, object] = {
        "17": {
            "class_type": "LoadImage",
            "inputs": {"image": "clipspace/mask.png [input]"},
        },
        "18": {
            "class_type": "LoadImageMask",
            "inputs": {"image": "portrait.png"},
        },
    }

    prepared = prepare_local_workflow_inputs(workflow, tmp_path)

    masked_node = prepared.workflow["17"]
    plain_node = prepared.workflow["18"]

    assert masked_node["inputs"]["image"] == "clipspace/mask.png"
    assert plain_node["inputs"]["image"] == "portrait.png"
    assert prepared.missing_files == ()
    assert prepared.input_images == {
        "clipspace/mask.png": base64.b64encode(b"mask-bytes").decode("ascii"),
        "portrait.png": base64.b64encode(b"portrait-bytes").decode("ascii"),
    }
    assert workflow["17"]["inputs"]["image"] == "clipspace/mask.png [input]"
