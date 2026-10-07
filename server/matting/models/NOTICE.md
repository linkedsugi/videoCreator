# selfie-segmenter.onnx

Person segmentation model used to cut the presenter out of the camera picture.

- Source: MediaPipe Selfie Segmenter (`selfie_segmenter.tflite`, float16),
  https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
- Authors: Tingbo Hou, Siargey Pisarchyk, Karthik Raveendran (Google), May 2021
- License: Apache License 2.0 (see `LICENSE-APACHE-2.0.txt`)

Changes made for this project: converted from TFLite to ONNX with tf2onnx
(opset 17), and MediaPipe's custom `Convolution2DTransposeBias` op replaced by
the equivalent standard ONNX `ConvTranspose` with bias.

Input: `[1, 256, 256, 3]` RGB in 0–1. Output: `[1, 256, 256, 1]` person
probability in 0–1.
