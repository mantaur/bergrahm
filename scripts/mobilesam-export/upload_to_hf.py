"""
Upload Qualcomm MobileSAM ONNX files to HuggingFace.

Before running:
  huggingface-cli login          # paste your HF write token when prompted
  (token at huggingface.co/settings/tokens)

Then:
  python3 upload_to_hf.py
"""

from huggingface_hub import HfApi, create_repo
import os

REPO_ID    = "mantaur/mobile-sam-onnx"
MODEL_DIR  = os.path.join(os.path.dirname(__file__), "mobilesam-onnx-float")
FILES      = ["encoder.onnx", "encoder.data", "decoder.onnx", "decoder.data"]

api = HfApi()

print(f"Creating repo {REPO_ID} (skipped if already exists)...")
create_repo(REPO_ID, repo_type="model", private=False, exist_ok=True)

for fname in FILES:
    local = os.path.join(MODEL_DIR, fname)
    size  = os.path.getsize(local) / 1024 / 1024
    print(f"Uploading {fname} ({size:.1f} MB)...")
    api.upload_file(
        path_or_fileobj=local,
        path_in_repo=fname,
        repo_id=REPO_ID,
        repo_type="model",
    )
    print(f"  done.")

print("\nAll files uploaded.")
print(f"Model URL: https://huggingface.co/{REPO_ID}")
