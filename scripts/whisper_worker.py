"""Transcribes audio clips for live meetings with local speech models.

Reads one JSON request per line on stdin, {"id", "path", "language"?, "preview"?},
and writes one JSON reply per line on stdout, {"id", "text"} or {"id", "error"}.

Previews (the clip so far, shown while someone is still talking) use SenseVoice,
which takes about 0.15 s per clip. Kept lines use Whisper, which is slower but
gets English terms in Chinese speech right. Both models load once.
"""

import json
import os
import re
import subprocess
import sys

import mlx_whisper
import numpy as np

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
SENSEVOICE_DIR = os.path.expanduser(os.environ.get("SENSEVOICE_DIR", "~/.cache/sherpa/sv"))

# Whisper invents these on silence or music; a clip that is only one of them is dropped.
HALLUCINATIONS = {
    "thank you.", "thanks for watching!", "thank you for watching.", "you", "bye.", "obrigado.",
    "谢谢观看", "谢谢大家", "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
}

# The same word or short phrase four or more times in a row is a Whisper loop.
REPEAT = re.compile(r"((?:\S+?\s?){1,3}?)\1{3,}")

sensevoice = None


def load_sensevoice():
    global sensevoice
    if sensevoice is None:
        import sherpa_onnx

        sensevoice = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=f"{SENSEVOICE_DIR}/model.int8.onnx",
            tokens=f"{SENSEVOICE_DIR}/tokens.txt",
            use_itn=True,
            language="auto",
            num_threads=4,
        )
    return sensevoice


def pcm(path):
    raw = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768


def preview(path):
    recognizer = load_sensevoice()
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, pcm(path))
    recognizer.decode_stream(stream)
    return stream.result.text.strip()


def final(path, language):
    result = mlx_whisper.transcribe(
        path,
        path_or_hf_repo=WHISPER_MODEL,
        language=language or None,
        condition_on_previous_text=False,
    )
    kept = [
        segment["text"].strip()
        for segment in result.get("segments", [])
        if segment.get("no_speech_prob", 0) < 0.6
        and segment.get("avg_logprob", 0) > -1.0
        and segment.get("compression_ratio", 0) < 2.2
    ]
    text = REPEAT.sub(r"\1", " ".join(part for part in kept if part)).strip()
    if text.lower() in HALLUCINATIONS:
        text = ""
    # Whisper sometimes swaps a whole clip for text it has seen in training
    # (video credits, subtitle notices). When its text shares little with what
    # SenseVoice heard in the same clip, SenseVoice's text is kept instead.
    # Whisper can invent text over silence, so a clip where SenseVoice heard
    # nothing is dropped.
    fallback = preview(path)
    if not fallback:
        return ""
    if overlap(text, fallback) < 0.4:
        return fallback
    return text


def overlap(text, reference):
    """Share of the reference's Chinese characters that also occur in the text.

    English words are left out: SenseVoice garbles them (Redis comes out as
    "RACE"), so they say nothing about whether Whisper heard the same thing.
    """
    def units(value):
        return re.findall(r"[\u4e00-\u9fff]", value)

    wanted = units(reference)
    if len(wanted) < 4:
        return 1.0
    have = {}
    for unit in units(text):
        have[unit] = have.get(unit, 0) + 1
    hits = 0
    for unit in wanted:
        if have.get(unit):
            have[unit] -= 1
            hits += 1
    return hits / len(wanted)


def main():
    for line in sys.stdin:
        request = json.loads(line)
        try:
            if request.get("preview"):
                text = preview(request["path"])
            else:
                text = final(request["path"], request.get("language"))
            reply = {"id": request["id"], "text": text}
        except Exception as error:  # one bad clip must not stop the worker
            reply = {"id": request["id"], "error": str(error)}
        sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
