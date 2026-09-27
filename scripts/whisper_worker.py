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
import time

import mlx_whisper
import numpy as np

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
SENSEVOICE_DIR = os.path.expanduser(os.environ.get("SENSEVOICE_DIR", "~/.cache/sherpa/sv"))

# Whisper invents these on silence or music; a clip that is only one of them is dropped.
HALLUCINATIONS = {
    "thank you.", "thanks for watching!", "thank you for watching.", "you", "bye.", "obrigado.",
    "谢谢观看", "谢谢大家", "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
}

# Where each clip's timings go, so a slow one can be traced to decoding, Whisper, or SenseVoice.
TIMING_LOG = os.environ.get("WHISPER_TIMING_LOG", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tmp", "whisper-timing.jsonl"))

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


def final(path, language, timing):
    started = time.time()
    # One decoding pass with a token cap: a clip is a few seconds long, and a
    # Whisper loop on noisy audio would otherwise run to the model's limit and
    # hold up every clip queued behind it.
    result = mlx_whisper.transcribe(
        path,
        path_or_hf_repo=WHISPER_MODEL,
        language=language or None,
        condition_on_previous_text=False,
        temperature=0.0,
        sample_len=96,
    )
    timing["whisper_ms"] = int((time.time() - started) * 1000)
    kept = [
        segment["text"].strip()
        for segment in result.get("segments", [])
        if segment.get("no_speech_prob", 0) < 0.6
        and segment.get("avg_logprob", 0) > -1.0
        and segment.get("compression_ratio", 0) < 2.2
    ]
    # SenseVoice hears the same clip and does not invent captions the way
    # Whisper does ("中文字幕志愿者 李宗盛"), so it is the check: nothing heard
    # means nothing kept, and a Whisper sentence whose characters SenseVoice
    # mostly did not hear is dropped, even when the rest of the clip is real.
    started = time.time()
    heard = preview(path)
    timing["sensevoice_ms"] = int((time.time() - started) * 1000)
    if not heard:
        return ""
    kept = [part for part in kept if part and overlap(heard, part) >= 0.3]
    text = REPEAT.sub(r"\1", " ".join(kept)).strip()
    if text.lower() in HALLUCINATIONS:
        text = ""
    # When Whisper's text as a whole shares little with what SenseVoice heard,
    # SenseVoice's text is kept instead.
    if overlap(text, heard) < 0.4:
        return heard
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


def log_timing(entry):
    try:
        with open(TIMING_LOG, "a", encoding="utf-8") as file:
            file.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


def main():
    for line in sys.stdin:
        request = json.loads(line)
        started = time.time()
        timing = {"at": round(started, 1), "preview": bool(request.get("preview"))}
        try:
            if request.get("preview"):
                text = preview(request["path"])
            else:
                text = final(request["path"], request.get("language"), timing)
            reply = {"id": request["id"], "text": text}
        except Exception as error:  # one bad clip must not stop the worker
            reply = {"id": request["id"], "error": str(error)}
        timing["total_ms"] = int((time.time() - started) * 1000)
        timing["chars"] = len(reply.get("text", ""))
        log_timing(timing)
        sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
