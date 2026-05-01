#!/usr/bin/env python3
import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from modal_client import batch_download_models

MODELS = [
    {
        "url": "https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/diffusion_models/anima-preview3-base.safetensors",
        "filename": "animaOfficial_preview3Base.safetensors",
        "save_path": "diffusion_models",
    },
    {
        "url": "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors",
        "filename": "qwen_image_vae.safetensors",
        "save_path": "vae",
    },
    {
        "url": "https://huggingface.co/Qwen/Qwen3-0.6B/resolve/main/model.safetensors",
        "filename": "qwen_3_06b_base.safetensors",
        "save_path": "clip",
    },
    {
        "url": "https://huggingface.co/FacehugmanIII/4x_foolhardy_Remacri/resolve/main/4x_foolhardy_Remacri.pth",
        "filename": "4x_foolhardy_Remacri.pth",
        "save_path": "upscale_models",
    },
    {
        "url": "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth",
        "filename": "sam_vit_b_01ec64.pth",
        "save_path": "sams",
    },
    {
        "url": "https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov9c.pt",
        "filename": "face_yolov9c.pt",
        "save_path": "ultralytics/bbox",
    },
    {
        "url": "https://huggingface.co/Bingsu/adetailer/resolve/main/hand_yolov9c.pt",
        "filename": "hand_yolov9c.pt",
        "save_path": "ultralytics/bbox",
    },
    {
        "url": "https://huggingface.co/Bryan32/Adetailer/resolve/main/Eyeful_v2-Individual.pt",
        "filename": "Eyeful_v2-Individual.pt",
        "save_path": "ultralytics/bbox",
    },
    {
        "url": "https://huggingface.co/Nudimmud/adetailers/resolve/main/ntd11_anime_nsfw_segm_v5-variant1.pt",
        "filename": "ntd11_anime_nsfw_segm_v5-variant1.pt",
        "save_path": "ultralytics/segm",
    },
    {
        "url": "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11m-seg.pt",
        "filename": "segm/yolo11m-seg.pt",
        "save_path": "ultralytics/segm",
    },
]

async def main():
    print(f"Downloading {len(MODELS)} models to Modal volume...")
    results = await batch_download_models(MODELS)
    for r in results:
        status = "✓ skipped (exists)" if r.get("skipped") else ("✓ done" if r.get("status") == "ok" else f"✗ {r.get('error', 'unknown error')}")
        print(f"  {r.get('filename', '?')}: {status}")
    print("Done.")

if __name__ == "__main__":
    asyncio.run(main())
