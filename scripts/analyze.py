import argparse
import json
import os
import sys
import hashlib

import numpy as np
import librosa

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SR = 22050  # sample rate
NOTE_FRAME_HOP = 2048  # ~93ms per chroma/notes frame at SR=22050
WAVEFORM_POINTS = 1200
PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# krumhansl-kessler key profiles
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def estimate_key(chroma_mean):
    best_score, best_label = -np.inf, "C Major"
    for shift in range(12):
        maj = np.roll(MAJOR_PROFILE, shift)
        minr = np.roll(MINOR_PROFILE, shift)
        maj_score = np.corrcoef(chroma_mean, maj)[0, 1]
        min_score = np.corrcoef(chroma_mean, minr)[0, 1]
        if maj_score > best_score:
            best_score, best_label = maj_score, f"{PITCH_CLASSES[shift]} Major"
        if min_score > best_score:
            best_score, best_label = min_score, f"{PITCH_CLASSES[shift]} Minor"
    return best_label


def notes_timeline(chroma, top_n=3, threshold=0.55):
    # list pitch classes whose chroma is within threshold of frame's peak
    frames = []
    for col in chroma.T:
        peak = col.max()
        if peak <= 1e-6:
            frames.append([])
            continue
        idx = np.where(col >= peak * threshold)[0]
        idx = idx[np.argsort(-col[idx])][:top_n]
        frames.append([PITCH_CLASSES[i] for i in idx])
    return frames


def downsample_envelope(y, points):
    hop = max(1, len(y) // points)
    peaks = []
    for i in range(0, len(y), hop):
        chunk = y[i:i + hop]
        if len(chunk):
            peaks.append(float(np.max(np.abs(chunk))))
    # normalize
    m = max(peaks) if peaks else 1.0
    return [round(p / m, 4) for p in peaks[:points]]


def stable_id(path):
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:10]


def analyze_file(path, overrides):
    name = os.path.splitext(os.path.basename(path))[0]
    print(f"Analyzing {name} ...")

    y, sr = librosa.load(path, sr=SR, mono=True)
    duration = len(y) / sr

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    tempo = float(np.atleast_1d(tempo)[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()

    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr)
    onset_times = librosa.frames_to_time(onset_frames, sr=sr).tolist()

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=NOTE_FRAME_HOP)
    frame_dt = NOTE_FRAME_HOP / sr
    key_label = estimate_key(chroma.mean(axis=1))
    notes = notes_timeline(chroma)

    waveform = downsample_envelope(y, WAVEFORM_POINTS)

    # per-channel rms
    try:
        y_stereo, _ = librosa.load(path, sr=SR, mono=False)
        if y_stereo.ndim == 2:
            rms_l = float(np.sqrt(np.mean(y_stereo[0] ** 2)))
            rms_r = float(np.sqrt(np.mean(y_stereo[1] ** 2)))
        else:
            rms_l = rms_r = float(np.sqrt(np.mean(y_stereo ** 2)))
    except Exception:
        rms_l = rms_r = 0.5

    meta = overrides.get(os.path.basename(path), {})
    title = meta.get("title", name.replace("_", " ").replace("-", " ").title())
    tag = meta.get(
        "tag",
        f"{round(tempo)} bpm \u00b7 key of {key_label} \u00b7 {int(duration // 60)}:{int(duration % 60):02d}",
    )

    return {
        "id": stable_id(name),
        "file": f"tracks/{os.path.basename(path)}",
        "title": title,
        "tag": tag,
        "duration": duration,
        "tempo": round(tempo, 2),
        "key": key_label,
        "beat_times": [round(t, 3) for t in beat_times],
        "onset_times": [round(t, 3) for t in onset_times],
        "notes_frame_dt": round(frame_dt, 5),
        "notes_timeline": notes,
        "waveform": waveform,
        "balance": {"l": round(rms_l, 4), "r": round(rms_r, 4)},
    }


def main():
    parser = argparse.ArgumentParser(description="Analyze mp3s into visualizer JSON.")
    parser.add_argument("--tracks", default=os.path.join(ROOT, "tracks"),
                         help="Folder of source .mp3 files")
    parser.add_argument("--out", default=ROOT,
                         help="Output folder: gets manifest.json + data/*.json written into it")
    parser.add_argument("--meta", default=os.path.join(ROOT, "tracks.meta.json"),
                         help="Optional JSON overrides keyed by mp3 filename")
    args = parser.parse_args()

    data_dir = os.path.join(args.out, "data")
    os.makedirs(data_dir, exist_ok=True)

    overrides = {}
    if os.path.exists(args.meta):
        with open(args.meta) as f:
            overrides = json.load(f)

    if not os.path.isdir(args.tracks):
        print(f"Tracks folder not found: {args.tracks}", file=sys.stderr)
        sys.exit(1)

    existing_order = {}
    for candidate in (os.path.join(args.out, "manifest.json"), os.path.join(ROOT, "manifest.json")):
        if os.path.exists(candidate):
            try:
                with open(candidate) as mf:
                    prev = json.load(mf)
                for idx, entry in enumerate(prev):
                    fname = os.path.basename(entry.get("file", "")) if entry.get("file") else ""
                    if fname:
                        existing_order[fname] = idx
                    if entry.get("title"):
                        existing_order.setdefault(entry["title"], idx)
            except Exception:
                pass
            break

    mp3s_all = [f for f in os.listdir(args.tracks) if f.lower().endswith(".mp3")]

    if existing_order:
        def _manifest_sort_key(fname):
            if fname in existing_order:
                return (0, existing_order[fname])
            return (1, fname.lower())
        mp3s = sorted(mp3s_all, key=_manifest_sort_key)
    elif overrides:
        meta_order = {k: i for i, k in enumerate(overrides.keys())}
        mp3s = sorted(mp3s_all, key=lambda f: (meta_order.get(f, len(meta_order)), f.lower()))
    else:
        mp3s = sorted(mp3s_all, key=lambda f: f.lower())
    if not mp3s:
        print(f"No mp3 files found in {args.tracks}. Add some and re-run.", file=sys.stderr)

    manifest = []
    for fname in mp3s:
        path = os.path.join(args.tracks, fname)
        try:
            result = analyze_file(path, overrides)
        except Exception as e:
            print(f"  FAILED on {fname}: {e}", file=sys.stderr)
            continue
        out_path = os.path.join(data_dir, f"{result['id']}.json")
        with open(out_path, "w") as f:
            json.dump(result, f)
        manifest.append({
            "id": result["id"],
            "title": result["title"],
            "tag": result["tag"],
            "file": result["file"],
            "data": f"data/{result['id']}.json",
            "duration": result["duration"],
            "key": result["key"],
            "tempo": result["tempo"],
        })
        print(f"  -> {out_path}  ({round(result['duration'],1)}s, {result['tempo']} bpm, {result['key']})")

    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nWrote manifest.json with {len(manifest)} track(s) to {args.out}")


if __name__ == "__main__":
    main()
