"""
Download yolo11n-seg.pt and export to ONNX.
Applies a torchvision Python-3.14 compatibility patch before import.
"""

import torch

# torchvision 0.26 fails on Python 3.14 because torchvision::nms isn't
# registered yet when _meta_registrations tries to attach a fake impl.
# Pre-declare it so the registration succeeds.
_tv_lib = torch.library.Library("torchvision", "DEF")
_tv_lib.define("nms(Tensor dets, Tensor scores, float iou_threshold) -> Tensor")

from ultralytics import YOLO  # noqa: E402 — must come after patch

model = YOLO("yolo11n-seg.pt")   # auto-downloads if not present
print("task:", model.task)
print("exporting to ONNX...")
path = model.export(format="onnx", imgsz=640, simplify=True, opset=17)
print("exported to:", path)
