#!/usr/bin/env python3
"""Objective music DSP for a replication evidence pack.

Why this file exists: an LLM cannot measure tempo, key or cadence from a
description, and Whisper cannot measure music at all. Every number this worker
prints is computed from samples. Anything it cannot measure is reported as
``null`` with a reason in ``unmeasured`` — it never guesses.

Dependency rule: **numpy only**. librosa pulls numba/llvmlite (~200 MB) and this
machine has 2 GB of usable RAM; the algorithms below are textbook and are
verified against synthetic signals with known ground truth in
``tests/dsp.test.mjs``.

Reads a mono PCM WAV (decode it with ffmpeg first), writes one JSON line:

    MEDIA_EVIDENCE_RESULT {...}

Library logging may share stdout, so the marker is how the caller finds the
result (same contract as ``stt_worker.py``).
"""
from __future__ import annotations

import argparse
import json
import math
import resource
import sys
import time
import wave

import numpy as np

MARKER = "MEDIA_EVIDENCE_RESULT "
PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Kessler key profiles: perceived stability of each scale degree.
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

N_FFT = 2048
HOP = 512
SERIES_HZ = 2.0


# ------------------------------------------------------------------ input ----
def read_wav(path):
    """Read a mono (or mixable) PCM/float WAV as float32 in [-1, 1]."""
    with wave.open(path, "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.getnframes()
        raw = handle.readframes(frames)
    if width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    elif width == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f"unsupported WAV sample width: {width} bytes")
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    if rate <= 0:
        raise ValueError(f"WAV reports an invalid sample rate: {rate}")
    return np.ascontiguousarray(data, dtype=np.float32), int(rate)


# ------------------------------------------------------------------- stft ----
def stft_magnitude(x, n_fft=N_FFT, hop=HOP):
    """Frame the signal once (a strided view, no copies) and rFFT in chunks."""
    if len(x) < n_fft:
        x = np.pad(x, (0, n_fft - len(x)))
    n_frames = 1 + (len(x) - n_fft) // hop
    pad = n_fft // 2
    needed = (n_frames - 1) * hop + n_fft
    xp = np.zeros(pad + max(needed, len(x)), dtype=np.float32)
    xp[pad:pad + len(x)] = x
    window = np.hanning(n_fft).astype(np.float32)
    view = np.lib.stride_tricks.sliding_window_view(xp, n_fft)[::hop][:n_frames]
    mag = np.empty((n_fft // 2 + 1, n_frames), dtype=np.float32)
    for start in range(0, n_frames, 512):
        block = view[start:start + 512] * window
        mag[:, start:start + 512] = np.abs(np.fft.rfft(block, axis=1)).T.astype(np.float32)
    return mag


def frame_rms(x, n_frames, n_fft=N_FFT, hop=HOP):
    """RMS per STFT frame, taken from the same frame grid as the spectrum."""
    view = np.lib.stride_tricks.sliding_window_view(x, min(n_fft, len(x)))[::hop][:n_frames]
    return np.sqrt(np.mean(view.astype(np.float64) ** 2, axis=1))


# --------------------------------------------------------------- onsets ------
def moving_average_time(matrix, width):
    """Mean over `width` frames along time (cumsum, no large temporary).

    Alignment matters more than it looks: an earlier cumsum version was off by
    one frame and lost its last column, which moved the strongest flux from the
    attack to an edge artefact and turned a steady tone into 57 fake onsets.
    This is verified against `np.convolve(..., mode="same")` in tests/dsp.test.mjs.
    """
    if width <= 1:
        return matrix.astype(np.float64)
    left, right = width // 2, width - 1 - width // 2
    padded = np.pad(matrix.astype(np.float64), ((0, 0), (left, right)), mode="edge")
    cumulative = np.concatenate(
        [np.zeros((padded.shape[0], 1), dtype=np.float64), np.cumsum(padded, axis=1)], axis=1)
    means = (cumulative[:, width:] - cumulative[:, :-width]) / float(width)
    return means[:, : matrix.shape[1]]


def onset_envelope(mag, frame_rate, smooth_frames=3):
    """Frame-to-frame rise in total spectral energy, scaled to [0, 1].

    Why energy and not spectral flux: flux is the textbook onset signal, but on
    this material it fails a checkable test. Measured on synthetic signals with
    known ground truth (see tests/dsp.test.mjs), onsets reported for a 5 s steady
    440 Hz sine:

        log1p spectral flux, no smoothing        63   <- window-phase leakage
        log1p spectral flux, 5-frame smoothing    2   (but 39-73 with dB flux)
        20*log10 flux over 1025 bins             65
        10*log10 total-energy rise (this one)     1

    Total energy is invariant to leakage across bins, so a sustained note has a
    flat rise-by-construction. Click tracks are unaffected: 19 onsets at 120 BPM,
    15 at 96 BPM, 31 with off-beat eighths added.

    Known limit, stated rather than hidden: this detects *loudness* onsets. A
    quiet hi-hat over a constant bed may not raise total energy and will not be
    counted, which is why the pack also reports the beat grid and the onset rate
    rather than pretending the list is every note played.
    """
    base = mag if smooth_frames <= 1 else moving_average_time(mag, smooth_frames)
    energy = (base.astype(np.float64) ** 2).sum(axis=0)
    energy_db = 10.0 * np.log10(np.maximum(energy, 1e-12))
    rise = np.maximum(np.diff(energy_db, prepend=energy_db[:1]), 0.0)
    width = max(3, int(round(0.5 * frame_rate)) | 1)
    padded = np.pad(rise, (width // 2, width // 2), mode="edge")
    floor = np.median(np.lib.stride_tricks.sliding_window_view(padded, width), axis=1)
    raw = np.maximum(rise - floor, 0.0)
    peak = float(raw.max()) if raw.size else 0.0
    if peak <= 1e-9:
        zeros = np.zeros_like(raw)
        return zeros, zeros, 0.0
    env = raw / peak
    return env, env - env.mean(), peak


def pick_onsets(env, frame_rate, min_gap_sec=0.05):
    """Local maxima above an adaptive threshold, at least min_gap apart."""
    if len(env) < 3:
        return np.zeros(0)
    window = max(3, int(round(0.06 * frame_rate)) | 1)
    padded = np.pad(env, (window // 2, window // 2), mode="edge")
    local_max = np.max(np.lib.stride_tricks.sliding_window_view(padded, window), axis=1)
    threshold = max(float(np.median(env) + 0.8 * env.std()), 0.02)
    candidates = np.where((env >= local_max - 1e-12) & (env > threshold))[0]
    if len(candidates) == 0:
        return np.zeros(0)
    min_gap = max(1, int(round(min_gap_sec * frame_rate)))
    kept = [candidates[0]]
    for index in candidates[1:]:
        if index - kept[-1] >= min_gap:
            kept.append(index)
        elif env[index] > env[kept[-1]]:
            kept[-1] = index
    return np.array(kept, dtype=np.float64)


def ac_at(ac, lag):
    """Autocorrelation at a fractional lag (linear interpolation).

    Integer lags quantise the period: a 120 BPM click track has a period of
    21.53 frames, so its individual pulses land at 21.53, 43.06, 64.60 ... while
    the autocorrelation can only be sampled at 22, 44, 66. The accumulated
    error made the half-tempo family (whose multiples happen to land on whole
    frames) outscore the true tempo, reporting 60.1 BPM for a metronome at 120.
    """
    if lag <= 0:
        return float(ac[0]) if len(ac) else 0.0
    index = int(np.floor(lag))
    if index >= len(ac) - 1:
        return 0.0
    fraction = float(lag) - index
    return float(ac[index] * (1.0 - fraction) + ac[index + 1] * fraction)


def autocorrelation(env):
    """Normalised autocorrelation via FFT; index 0 is always 1.0."""
    n = len(env)
    size = 1 << int(math.ceil(math.log2(max(2 * n, 2))))
    spectrum = np.fft.rfft(env, size)
    ac = np.fft.irfft(spectrum * np.conj(spectrum), size)[:n]
    return ac / ac[0] if ac[0] > 0 else ac


def is_same_tempo_family(bpm_a, bpm_b, lag_a=None, lag_b=None):
    """Same tempo? Adjacent autocorrelation lags are a quantisation artefact.

    Integer lags quantise the period: lag 21 and lag 22 are 123.0 and 117.5 BPM —
    the same beat, measured twice. Treating that pair as a rival halved the
    reported confidence of a metronome-accurate click track to 0.15.
    """
    if lag_a is not None and lag_b is not None and abs(lag_a - lag_b) <= 1.0:
        return True
    ratio = bpm_a / bpm_b if bpm_b else 0.0
    return any(abs(ratio - target) <= 0.05 * target for target in (1.0, 0.5, 2.0, 1.5, 2.0 / 3.0))


def tempo_candidates(env, frame_rate, min_bpm=50.0, max_bpm=200.0, top=5):
    """Harmonically-summed autocorrelation tempo, with a log-normal prior.

    Autocorrelation alone reports a tempo *family* (60/120/180 all score); the
    harmonic sum (ac[p] + ac[2p] + ac[3p] + ac[4p]) pushes the fundamental
    forward, and the prior centred on 120 BPM settles genuine ambiguity the way
    published beat trackers do. Candidates are returned, never just one number.
    """
    ac = autocorrelation(env)
    min_lag = max(2.0, frame_rate * 60.0 / max_bpm)
    max_lag = min(len(ac) - 2.0, frame_rate * 60.0 / min_bpm)
    if max_lag <= min_lag:
        return []
    scored = []
    # Fractional lags, not integer ones: a period that falls between frames must
    # still be scored at its true value or its harmonics miss the peaks.
    for step in range(int(round((max_lag - min_lag) / 0.25)) + 1):
        lag = min_lag + step * 0.25
        total = harmonic_score(ac, lag)
        bpm = frame_rate * 60.0 / lag
        prior = math.exp(-0.5 * (math.log2(max(bpm, 1.0) / 120.0) / 0.9) ** 2)
        scored.append((lag, bpm, total * prior, total))
    scored.sort(key=lambda row: row[2], reverse=True)
    families = []
    for lag, bpm, score, raw in scored:
        if score <= 0:
            continue
        merged = False
        for family in families:
            if is_same_tempo_family(bpm, family["bpm"], lag, family["lagFrames"]):
                family["members"] += 1
                merged = True
                break
        if merged:
            continue
        families.append({
            "bpm": round(bpm, 2),
            "lagFrames": round(float(lag), 3),
            "score": round(float(score), 6),
            "harmonicScore": round(float(raw), 6),
            "priorWeight": round(math.exp(-0.5 * (math.log2(max(bpm, 1.0) / 120.0) / 0.9) ** 2), 4),
            "members": 1,
        })
        if len(families) >= top:
            break
    return families


def harmonic_score(ac, lag):
    """Weighted autocorrelation sum at a (possibly fractional) lag."""
    total = 0.0
    weight = 1.0
    for multiple in (1, 2, 3, 4):
        probe = lag * multiple
        if probe >= len(ac) - 1:
            break
        total += weight * ac_at(ac, probe)
        weight *= 0.6
    return total


def refine_period(ac, lag):
    """Refine the period by maximising the same objective used to pick it.

    A parabolic fit on a very sharp autocorrelation peak biased a perfect 120 BPM
    metronome down to 118.7 BPM (measured); maximising the harmonic score instead
    has no such bias because it optimises exactly what selected the candidate.
    """
    best_lag, best_score = float(lag), harmonic_score(ac, lag)
    step = 0.5
    while step >= 0.02:
        moved = False
        for delta in (-step, step):
            probe = best_lag + delta
            if probe <= 1.0:
                continue
            score = harmonic_score(ac, probe)
            if score > best_score:
                best_lag, best_score, moved = probe, score, True
        if not moved:
            step /= 2.0
    return float(best_lag)


def beat_grid(env, period_frames, frame_rate):
    """Best phase for a constant-tempo grid, then the beat times it implies."""
    if period_frames <= 1 or len(env) == 0:
        return None
    steps = max(16, int(min(400, round(period_frames * 4))))
    best_offset, best_score = 0.0, -np.inf
    for offset in np.linspace(0.0, period_frames, steps, endpoint=False):
        indices = np.round(offset + np.arange(0, len(env), period_frames)).astype(int)
        indices = indices[indices < len(env)]
        if len(indices) == 0:
            continue
        lo = np.maximum(indices - 1, 0)
        hi = np.minimum(indices + 1, len(env) - 1)
        score = float(np.mean(np.maximum.reduce([env[lo], env[indices], env[hi]])))
        if score > best_score:
            best_offset, best_score = float(offset), score
    indices = np.round(best_offset + np.arange(0, len(env), period_frames)).astype(int)
    indices = indices[indices < len(env)]
    times = indices / frame_rate
    baseline = float(np.mean(env)) or 1.0
    return {
        "offsetFrames": round(best_offset, 3),
        "firstBeatSec": round(float(times[0]), 3) if len(times) else None,
        "count": int(len(times)),
        "alignmentRatio": round(float(np.mean(env[indices])) / baseline, 3) if len(indices) else None,
        "times": [round(float(t), 3) for t in times],
    }


# ---------------------------------------------------------------- chroma ------
def chromagram(mag, sample_rate, n_fft=N_FFT, fmin=55.0, fmax=2093.0):
    """Per-frame pitch-class energy: each FFT bin votes for its nearest class."""
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    selected = np.where((freqs >= fmin) & (freqs <= fmax))[0]
    if len(selected) == 0:
        return np.zeros((12, mag.shape[1])), np.zeros(12)
    midi = 69.0 + 12.0 * np.log2(freqs[selected] / 440.0)
    classes = np.mod(np.round(midi).astype(int), 12)
    chroma = np.zeros((12, mag.shape[1]), dtype=np.float64)
    np.add.at(chroma, classes, mag[selected].astype(np.float64))
    energy = chroma.sum(axis=0)
    floor = np.percentile(energy, 40) if energy.size else 0.0
    usable = energy > max(floor, 1e-12)
    normalised = np.zeros_like(chroma)
    normalised[:, usable] = chroma[:, usable] / energy[usable]
    global_chroma = normalised[:, usable].sum(axis=1) if usable.any() else chroma.sum(axis=1)
    peak = global_chroma.max() if global_chroma.size else 0.0
    if peak > 0:
        global_chroma = global_chroma / peak
    return normalised, global_chroma


def estimate_key(global_chroma):
    """Best Krumhansl-Kessler correlation over all 24 keys, with the margin."""
    if global_chroma.size != 12 or not np.any(global_chroma):
        return None
    centred = global_chroma - global_chroma.mean()
    denominator = np.linalg.norm(centred)
    if denominator < 1e-9:
        return None
    ranked = []
    for tonic in range(12):
        for mode, profile in (("major", KK_MAJOR), ("minor", KK_MINOR)):
            rotated = np.roll(profile, tonic)
            centred_profile = rotated - rotated.mean()
            correlation = float(np.dot(centred, centred_profile) / (denominator * np.linalg.norm(centred_profile)))
            ranked.append({
                "tonic": PITCH_CLASSES[tonic],
                "mode": mode,
                "correlation": round(correlation, 4),
            })
    ranked.sort(key=lambda row: row["correlation"], reverse=True)
    best = ranked[0]
    margin = best["correlation"] - ranked[1]["correlation"]
    return {
        "tonic": best["tonic"],
        "mode": best["mode"],
        "correlation": best["correlation"],
        "margin": round(float(margin), 4),
        "alternatives": ranked[1:4],
    }


# ------------------------------------------------------- harmonic/percussive ---
def log_band_spectrogram(mag, sample_rate, n_bands=48, fmin=60.0, fmax=8000.0):
    """Sum FFT bins into log-spaced bands: cheap enough for a 6-minute track."""
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sample_rate)
    edges = np.geomspace(fmin, min(fmax, sample_rate / 2 - 100.0), n_bands + 1)
    bands = np.zeros((n_bands, mag.shape[1]), dtype=np.float32)
    for index in range(n_bands):
        selected = np.where((freqs >= edges[index]) & (freqs < edges[index + 1]))[0]
        if len(selected):
            bands[index] = mag[selected].sum(axis=0)
    return bands


def hpss_ratio(bands, frame_rate):
    """Harmonic/percussive split from a 48-band reduction (a ratio, not stems).

    Harmonic content is smooth in time; percussive content is broadband and so
    smooth across frequency. Two medians separate them well enough to report an
    energy ratio and per-frame accents, which is all the pack claims.
    """
    time_window = max(3, int(round(0.4 * frame_rate)) | 1)
    freq_window = 9
    padded = np.pad(bands, ((0, 0), (time_window // 2, time_window // 2)), mode="edge")
    harmonic = np.median(np.lib.stride_tricks.sliding_window_view(padded, time_window, axis=1), axis=2)
    padded_freq = np.pad(bands, ((freq_window // 2, freq_window // 2), (0, 0)), mode="edge")
    percussive = np.median(
        np.lib.stride_tricks.sliding_window_view(padded_freq, freq_window, axis=0), axis=2)
    harmonic = np.maximum(harmonic, 1e-9)
    percussive = np.maximum(percussive, 1e-9)
    ratio = harmonic / (harmonic + percussive)
    return ratio.astype(np.float64), harmonic.sum(axis=0), percussive.sum(axis=0)


# ------------------------------------------------------------------ timbre ----
def mel_filterbank(sample_rate, n_mels=26, n_fft=N_FFT, fmin=60.0, fmax=None):
    fmax = fmax if fmax is not None else sample_rate / 2.0

    def hz_to_mel(f):
        return 2595.0 * np.log10(1.0 + f / 700.0)

    def mel_to_hz(m):
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    freqs = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    points = mel_to_hz(np.linspace(hz_to_mel(fmin), hz_to_mel(fmax), n_mels + 2))
    bank = np.zeros((n_mels, len(freqs)))
    for index in range(n_mels):
        left, centre, right = points[index], points[index + 1], points[index + 2]
        rising = (freqs - left) / max(centre - left, 1e-9)
        falling = (right - freqs) / max(right - centre, 1e-9)
        bank[index] = np.maximum(0.0, np.minimum(rising, falling))
    return bank


def dct_matrix(n_out=13, n_in=26):
    matrix = np.zeros((n_out, n_in))
    for k in range(n_out):
        scale = math.sqrt(1.0 / n_in) if k == 0 else math.sqrt(2.0 / n_in)
        for n in range(n_in):
            matrix[k, n] = scale * math.cos(math.pi * k * (n + 0.5) / n_in)
    return matrix


def mfcc_summary(mag, sample_rate):
    """Mean and spread of 13 MFCCs — a timbre fingerprint for later comparison."""
    bank = mel_filterbank(sample_rate)
    mel = bank @ mag.astype(np.float64)
    log_mel = np.log(np.maximum(mel, 1e-9))
    coeffs = dct_matrix() @ log_mel
    return {
        "mean": [round(float(v), 4) for v in coeffs.mean(axis=1)],
        "std": [round(float(v), 4) for v in coeffs.std(axis=1)],
        "nMels": int(bank.shape[0]),
        "nCoefficients": int(coeffs.shape[0]),
    }


# ---------------------------------------------------------------- sections ----
def section_map(chroma_series, energy_series, harmonic_series, hop_sec, duration):
    """Novelty from 4-second windows of chroma+energy+harmonic ratio.

    The pack must never say "verse" or "chorus": that is a semantic claim. It
    reports where the harmonic and energy character changed and leaves the naming
    to stage 2. Beat-synchronous windows were tried first and produced a single
    section for a 6-minute song because the beat grid is denser than the harmony
    changes; 4-second windows reproduce the audible structure instead.
    """
    window = 4.0
    block = max(1, int(round(window / hop_sec)))
    n_blocks = len(energy_series) // block
    if n_blocks < 6 or duration < 24.0:
        return [], "too short for a 4-second section map"
    features = []
    for index in range(n_blocks):
        start = index * block
        stop = start + block
        chroma = chroma_series[start:stop].mean(axis=0)
        magnitude = np.linalg.norm(chroma) or 1.0
        features.append(np.concatenate([
            chroma / magnitude * 3.0,
            [(energy_series[start:stop].mean() - float(np.mean(energy_series))) / (float(np.std(energy_series)) or 1.0)],
            [harmonic_series[start:stop].mean() * 2.0],
        ]))
    matrix = np.array(features)
    matrix = matrix / np.maximum(np.linalg.norm(matrix, axis=1, keepdims=True), 1e-9)
    novelty = 1.0 - np.sum(matrix[:-1] * matrix[1:], axis=1)
    if len(novelty) >= 3:
        novelty = np.convolve(novelty, np.ones(3) / 3.0, mode="same")
    threshold = float(np.median(novelty) * 1.6)
    candidates = [
        int(index) for index in range(1, len(novelty) - 1)
        if novelty[index] >= threshold and novelty[index] >= novelty[index - 1]
        and novelty[index] >= novelty[index + 1]
    ]
    boundaries = [0.0]
    for index in candidates:
        moment = float((index + 1) * window)
        if moment - boundaries[-1] >= 12.0 and duration - moment >= 12.0:
            boundaries.append(moment)
    boundaries.append(float(duration))
    sections = []
    for index in range(len(boundaries) - 1):
        start, end = boundaries[index], boundaries[index + 1]
        first = int(round(start / hop_sec))
        last = max(first + 1, int(round(end / hop_sec)))
        window_chroma = chroma_series[first:last]
        mean_chroma = window_chroma.mean(axis=0) if len(window_chroma) else np.zeros(12)
        ranked = np.argsort(mean_chroma)[::-1][:3]
        sections.append({
            "index": index + 1,
            "startSec": round(start, 2),
            "endSec": round(end, 2),
            "durationSec": round(end - start, 2),
            "energyDb": round(float(np.mean(energy_series[first:last])), 2),
            "harmonicRatio": round(float(np.mean(harmonic_series[first:last])), 3),
            "topPitchClasses": [PITCH_CLASSES[int(c)] for c in ranked if mean_chroma[c] > 0],
        })
    return sections, None


def downsample_series(values, frame_rate, target_hz=SERIES_HZ, reducer="mean"):
    if len(values) == 0:
        return []
    block = max(1, int(round(frame_rate / target_hz)))
    usable = (len(values) // block) * block
    if usable == 0:
        return []
    blocks = np.asarray(values)[:usable].reshape(-1, block)
    reduced = blocks.max(axis=1) if reducer == "max" else blocks.mean(axis=1)
    return [round(float(v), 4) for v in reduced]


def analyse(path, max_seconds=None):
    """Read a WAV and measure it."""
    samples, sample_rate = read_wav(path)
    return analyse_samples(samples, sample_rate, max_seconds, full_samples=len(samples))


def analyse_samples(samples, sample_rate, max_seconds=None, full_samples=None):
    """Measure in-memory samples. Split out so `--self-test` can use synthetic
    signals with known ground truth and never touch the disk."""
    started = time.time()
    full_samples = len(samples) if full_samples is None else full_samples
    truncated = False
    if max_seconds is not None and max_seconds > 0 and full_samples > max_seconds * sample_rate:
        samples = samples[: int(max_seconds * sample_rate)]
        truncated = True
    duration = len(samples) / float(sample_rate)
    unmeasured = {}

    result = {
        "ok": True,
        "worker": "dsp_worker",
        "workerVersion": "1.0.0",
        "analyzer": {
            "library": "numpy",
            "numpyVersion": np.__version__,
            "sampleRate": sample_rate,
            "nFft": N_FFT,
            "hop": HOP,
            "frameRate": round(sample_rate / HOP, 4),
            "seriesHz": SERIES_HZ,
            "note": "Spectral flux onsets, harmonically-summed autocorrelation tempo, "
                    "Krumhansl-Kessler key correlation, 48-band median-filter HPSS ratio, "
                    "26-mel / 13-coefficient MFCC. No stem separation and no instrument classification.",
        },
        "audio": {
            "durationSec": round(duration, 3),
            "fullFileDurationSec": round(full_samples / float(sample_rate), 3),
            "samples": int(len(samples)),
            "truncated": truncated,
        },
    }

    if duration < 1.0 or len(samples) == 0:
        result["silent"] = True
        unmeasured["all"] = "audio is shorter than 1 second"
        result["unmeasured"] = unmeasured
        result["analysis"] = {"audioSeconds": round(duration, 3), "elapsedMs": int((time.time() - started) * 1000)}
        return result

    frame_rate = sample_rate / HOP
    mag = stft_magnitude(samples)
    n_frames = mag.shape[1]
    rms = frame_rms(samples, n_frames)
    rms_db = 20.0 * np.log10(np.maximum(rms, 1e-9))
    overall_db = float(20.0 * np.log10(max(float(np.sqrt(np.mean(samples.astype(np.float64) ** 2))), 1e-9)))
    env, env_centred, flux_peak = onset_envelope(mag, frame_rate)

    result["energy"] = {
        "rmsDb": round(overall_db, 2),
        "peakDb": round(float(20.0 * np.log10(max(float(np.max(np.abs(samples))), 1e-9))), 2),
        "dynamicRangeDb": round(float(np.percentile(rms_db, 95) - np.percentile(rms_db, 10)), 2),
        "frameRmsDb": downsample_series(rms_db, frame_rate),
    }

    is_silent = overall_db < -55.0 or flux_peak <= 1e-9 or float(np.max(np.abs(samples))) < 1e-4
    if is_silent:
        result["silent"] = True
        unmeasured["tempo"] = f"no usable onset energy (overall RMS {overall_db:.1f} dBFS)"
        unmeasured["key"] = "no usable tonal energy in a silent or near-silent signal"
        unmeasured["sections"] = "no usable novelty in a silent or near-silent signal"
        result["tempo"] = None
        result["key"] = None
        result["beats"] = None
        result["onsets"] = None
        result["chroma"] = None
        result["cadence"] = None
        result["timbre"] = None
        result["sections"] = []
        result["unmeasured"] = unmeasured
        result["analysis"] = {
            "audioSeconds": round(duration, 3),
            "coverage": 1.0,
            "elapsedMs": int((time.time() - started) * 1000),
            "maxRssMb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0, 1),
        }
        return result
    result["silent"] = False

    onset_frames = pick_onsets(env, frame_rate)
    onset_times = onset_frames / frame_rate
    result["onsets"] = {
        "count": int(len(onset_times)),
        "ratePerSec": round(float(len(onset_times) / duration), 3),
        "times": [round(float(t), 3) for t in onset_times],
    }

    candidates = tempo_candidates(env_centred, frame_rate)
    beats = None
    if len(onset_times) < 4:
        unmeasured["tempo"] = f"only {len(onset_times)} onset(s) in {duration:.1f} s; a steady signal has no measurable pulse"
        result["tempo"] = None
        result["beats"] = None
    elif len(candidates) == 0:
        unmeasured["tempo"] = "no autocorrelation peak inside 50-200 BPM"
        result["tempo"] = None
    else:
        best = candidates[0]
        period = refine_period(autocorrelation(env_centred), best["lagFrames"])
        beats = beat_grid(env, period, frame_rate)
        rival = next((c for c in candidates[1:] if not is_same_tempo_family(c["bpm"], best["bpm"])), None)
        ratio = (rival["score"] / best["score"]) if rival and best["score"] > 0 else 0.0
        octave = None
        for multiple in (0.5, 2.0):
            probe_lag = period * multiple
            probe_score = harmonic_score(autocorrelation(env_centred), probe_lag)
            if probe_score > 0.75 * best["score"]:
                octave = {
                    "bpm": round(frame_rate * 60.0 / probe_lag, 2),
                    "score": round(float(probe_score), 6),
                    "relation": "double" if multiple == 0.5 else "half",
                }
                break
        result["tempo"] = {
            "bpm": round(frame_rate * 60.0 / period, 2),
            "confidence": round(max(0.0, min(1.0, 1.0 - ratio)), 3),
            "ambiguous": bool(ratio > 0.85),
            "octaveAlternative": octave,
            "candidates": candidates,
            "method": "harmonically-summed autocorrelation with a log-normal prior centred on 120 BPM",
            "note": "a pulse and its half/double are acoustically the same signal; the octaveAlternative "
                    "field reports the near-equal competitor rather than hiding the ambiguity",
        }
    result["beats"] = beats

    chroma_frames, global_chroma = chromagram(mag, sample_rate)
    key = estimate_key(global_chroma)
    if key is None:
        unmeasured["key"] = "chroma carried no pitch-class contrast"
    else:
        result["key"] = key
    ranked_chroma = np.argsort(global_chroma)[::-1]
    result["chroma"] = {
        "global": [round(float(v), 4) for v in global_chroma],
        "pitchClasses": PITCH_CLASSES,
        "top": [{"pitchClass": PITCH_CLASSES[int(c)], "weight": round(float(global_chroma[c]), 4)}
                for c in ranked_chroma[:5]],
    }

    bands = log_band_spectrogram(mag, sample_rate)
    harmonic, harmonic_energy, percussive_energy = hpss_ratio(bands, frame_rate)
    result["timbre"] = {
        "mfcc": mfcc_summary(mag, sample_rate),
        "harmonicPercussiveRatio": round(float(np.mean(harmonic)), 3),
        "harmonicRatioMethod": "median filtering on a 48-band log-frequency reduction; a ratio, not stems",
    }

    # Cadence: the measurable half of "how it moves".
    cadence = {}
    if len(onset_times) >= 4:
        gaps = np.diff(onset_times)
        gaps = gaps[(gaps > 0.05) & (gaps < 3.0)]
        if len(gaps) >= 4:
            cadence["ioiMedianSec"] = round(float(np.median(gaps)), 3)
            cadence["ioiP25Sec"] = round(float(np.percentile(gaps, 25)), 3)
            cadence["ioiP75Sec"] = round(float(np.percentile(gaps, 75)), 3)
            histogram, edges = np.histogram(gaps, bins=24, range=(0.08, 1.6))
            cadence["dominantIoiSec"] = round(float((edges[histogram.argmax()] + edges[histogram.argmax() + 1]) / 2), 3)
    if beats is not None and len(beats["times"]) >= 8:
        beat_times = np.array(beats["times"])
        # Percussive *energy* in dB, not its share of the total: the share
        # saturates at ~1.0 whenever percussion dominates and reported a flat
        # accent vector (0.995/1.000/0.992/0.998) on a real hip-hop track.
        percussive_db = 10.0 * np.log10(np.maximum(percussive_energy, 1e-9))
        # A beat is an event over its whole window, not one frame: sampling a
        # single frame gave a flat accent vector (0.979/0.981/0.970/1.000) on a
        # real hip-hop track because the sampled frame missed each hit.
        beat_period_frames = float(np.median(np.diff(beat_times))) * frame_rate
        half_window = max(1, int(round(0.4 * beat_period_frames)))
        beat_frames = np.clip(np.round(beat_times * frame_rate).astype(int), 0, len(percussive_db) - 1)
        # max, not mean: a grid whose phase is off by a few tens of milliseconds
        # still contains the hit inside the window, and an alternating strong/weak
        # pattern survives (measured alternation 0.86 on a 160 BPM grid with 40 %
        # second hits) where a mean flattened it to 0.14 on a flat metronome too.
        beat_db = np.array([
            float(np.max(percussive_db[max(0, frame - half_window):frame + half_window + 1]))
            for frame in beat_frames])
        beat_energy = np.power(10.0, (beat_db - float(beat_db.max())) / 10.0)
        even = beat_energy[0::2]
        odd = beat_energy[1::2]
        overall = float(np.mean(beat_energy)) or 1.0
        cadence["beatAlternationRatio"] = round(
            abs(float(np.mean(even)) - float(np.mean(odd))) / overall if len(even) and len(odd) else 0.0, 3)
        cadence["beatAlternationNote"] = (
            "difference between alternate beats, normalised. Near zero means the grid is the pulse; "
            "a large value means the real beat is probably half the reported tempo")
        accents = {}
        for grouping in (4, 3):
            positions = [[] for _ in range(grouping)]
            for index, energy in enumerate(beat_energy):
                positions[index % grouping].append(energy)
            means = [float(np.mean(p)) if p else 0.0 for p in positions]
            peak = max(means) if means else 0.0
            accents[f"accentPer{grouping}Beats"] = [round(m / peak, 3) if peak > 0 else 0.0 for m in means]
            accents[f"accentSpread{grouping}"] = round(float((peak - min(means)) / peak) if peak > 0 else 0.0, 3)
        cadence.update(accents)
        cadence["accentSource"] = ("peak percussive-band energy (dB) inside each beat, converted to linear "
                                   "energy relative to the loudest beat position")
        cadence["accentCaveat"] = ("measured in the percussive band only; a dense mix can flatten the pattern, "
                                   "so read accentSpread together with it rather than as a backbeat claim")
        cadence["accentGroupingNote"] = "both 4 and 3 are reported because the meter is a semantic claim, not a measurement"
        eighth = float(np.median(np.diff(beat_times)) / 2.0) if len(beat_times) > 1 else None
        if eighth and eighth > 0.02:
            offsets = np.abs(((onset_times / eighth) % 1.0) - 0.5) * eighth
            cadence["gridDeviationMedianMs"] = round(float(np.median(offsets) * 1000.0), 1)
            cadence["gridDeviationNote"] = "distance from the mid-point between eighth notes; small values mean a straight, "
            cadence["gridDeviationNote"] += "evenly-subdivided grid, larger values mean swung or triplet placements"
    if cadence:
        result["cadence"] = cadence
    else:
        unmeasured["cadence"] = "too few onsets or beats to describe a rhythm pattern"

    # 2 Hz series: the substrate for comparing a generated take against this source.
    block = max(1, int(round(frame_rate / SERIES_HZ)))
    usable = (chroma_frames.shape[1] // block) * block
    hop_sec = round(block / frame_rate, 4)
    chroma_series = chroma_frames[:, :usable].reshape(12, -1, block).mean(axis=2).T if usable else np.zeros((0, 12))
    energy_series = np.array(downsample_series(rms_db, frame_rate))
    harmonic_series = np.array(downsample_series(harmonic, frame_rate))
    onset_series = downsample_series(env, frame_rate, reducer="max")

    sections, section_note = section_map(chroma_series, energy_series, harmonic_series, hop_sec, duration)
    result["sections"] = sections
    if section_note:
        unmeasured["sections"] = section_note
    elif len(sections) <= 1:
        unmeasured["sections"] = "no character change cleared the novelty threshold"
    if sections:
        result["sectionNote"] = "energy/chroma novelty regions, not verse or chorus labels"

    if usable > 0:
        result["series"] = {
            "hopSec": hop_sec,
            "energyDb": [round(float(v), 4) for v in energy_series],
            "harmonicRatio": [round(float(v), 4) for v in harmonic_series],
            "onsetStrength": onset_series,
            "chroma": [round(float(v), 4) for v in chroma_series.reshape(-1)],
            "chromaLayout": "row-major, 12 values per frame in C..B order",
        }

    result["unmeasured"] = unmeasured
    result["analysis"] = {
        "audioSeconds": round(duration, 3),
        "coverage": round(duration / max(duration, 1e-9), 4),
        "elapsedMs": int((time.time() - started) * 1000),
        "maxRssMb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0, 1),
    }
    return result


def synthesize_clicks(bpm, seconds, amplitudes=(1.0,), offset=0.0, sample_rate=22050):
    """A click track with known ground truth: 1 kHz decaying bursts."""
    total = int(sample_rate * seconds)
    signal = np.zeros(total, dtype=np.float32)
    period = 60.0 / bpm
    burst = int(0.04 * sample_rate)
    envelope = np.exp(-np.linspace(0.0, 8.0, burst))
    time_at = offset
    index = 0
    while time_at < seconds:
        start = int(time_at * sample_rate)
        if start >= total:
            break
        stop = min(total, start + burst)
        length = stop - start
        signal[start:stop] += (np.sin(2.0 * np.pi * 1000.0 * np.arange(length) / sample_rate)
                               * envelope[:length] * amplitudes[index % len(amplitudes)])
        time_at += period
        index += 1
    return signal


def synthesize_tone(frequencies, seconds, amplitude=0.25, sample_rate=22050):
    time = np.arange(int(sample_rate * seconds)) / sample_rate
    signal = np.zeros(len(time), dtype=np.float32)
    for frequency in frequencies:
        signal += amplitude * np.sin(2.0 * np.pi * frequency * time)
    return signal


def self_test():
    """Ground-truth checks on synthetic signals.

    Every threshold below is a property of the signal, not a tolerance invented to
    make the code pass: a 120 BPM click track must report 120 BPM, a steady tone
    must report no pulse, a C-E-G triad must report C major.
    """
    checks = []

    def check(name, passed, detail):
        checks.append({"name": name, "passed": bool(passed), "detail": detail})

    # 1. Moving average must match the reference convolution in the interior.
    probe = np.arange(12, dtype=np.float64).reshape(1, 12)
    reference = np.apply_along_axis(lambda row: np.convolve(row, np.ones(5) / 5.0, mode="same"), 1, probe)
    smoothed = moving_average_time(probe, 5)
    delta = float(np.max(np.abs(smoothed[:, 2:-2] - reference[:, 2:-2])))
    check("moving average matches convolution", delta < 1e-9, f"interior max |delta| = {delta:.3e}")

    # 2. Tempo: 120 BPM clicks -> 120 BPM, 19 onsets in 10 s.
    result = analyse_samples(synthesize_clicks(120.0, 10.0), 22050)
    bpm = (result.get("tempo") or {}).get("bpm")
    onsets = result["onsets"]["count"]
    check("120 BPM click track", bpm is not None and abs(bpm - 120.0) < 2.0, f"reported {bpm} BPM")
    check("120 BPM onset count", abs(onsets - 19) <= 2, f"reported {onsets} onsets")

    # 3. Off-beat eighths must not double the tempo.
    combined = synthesize_clicks(96.0, 10.0) + 0.6 * synthesize_clicks(96.0, 10.0, offset=60.0 / 96.0 / 2.0)
    result = analyse_samples(combined, 22050)
    bpm = (result.get("tempo") or {}).get("bpm")
    check("96 BPM with off-beat eighths", bpm is not None and abs(bpm - 96.0) < 2.0, f"reported {bpm} BPM")

    # 4. Strong/weak alternation must be visible as alternation, not as a slower tempo.
    alternating = synthesize_clicks(160.0, 12.0, amplitudes=(0.9, 0.36))
    result = analyse_samples(alternating, 22050)
    ratio = (result.get("cadence") or {}).get("beatAlternationRatio")
    check("alternating accents are measured", ratio is not None and ratio > 0.3, f"alternation ratio {ratio}")

    # 5. A steady tone has no pulse and must not report one.
    result = analyse_samples(synthesize_tone([440.0], 5.0), 22050)
    onsets = result["onsets"]["count"]
    check("steady 440 Hz tone has no rhythm", onsets <= 2 and result.get("tempo") is None,
          f"{onsets} onsets, tempo {result.get('tempo')}")

    # 6. A C-E-G triad must read as C major.
    result = analyse_samples(synthesize_tone([261.63, 329.63, 392.0], 5.0), 22050)
    key = result.get("key") or {}
    check("C-E-G triad reads as C major", key.get("tonic") == "C" and key.get("mode") == "major",
          f"reported {key.get('tonic')} {key.get('mode')} (r {key.get('correlation')}, margin {key.get('margin')})")

    # 7. Silence must produce no claims at all.
    result = analyse_samples(np.zeros(22050 * 3, dtype=np.float32), 22050)
    check("silence claims nothing", result.get("silent") is True and result.get("tempo") is None
          and result.get("key") is None, f"silent={result.get('silent')} tempo={result.get('tempo')}")

    # 8. The whole file is measured, and truncation is reported when asked for.
    result = analyse_samples(synthesize_clicks(120.0, 6.0), 22050, max_seconds=3.0)
    check("truncation is reported", result["audio"]["truncated"] is True
          and result["audio"]["fullFileDurationSec"] > result["audio"]["durationSec"],
          f"analysed {result['audio']['durationSec']}s of {result['audio']['fullFileDurationSec']}s")

    failures = [entry for entry in checks if not entry["passed"]]
    return {"ok": len(failures) == 0, "worker": "dsp_worker", "checks": checks,
            "failed": len(failures), "passed": len(checks) - len(failures)}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Objective music DSP for an evidence pack")
    parser.add_argument("--audio", help="mono PCM WAV produced by ffmpeg")
    parser.add_argument("--max-seconds", type=float, default=None,
                        help="analysis window in seconds; omit for the whole file")
    parser.add_argument("--self-test", action="store_true",
                        help="run synthetic ground-truth checks and print the result")
    args = parser.parse_args(argv)
    if args.self_test:
        payload = self_test()
    elif not args.audio:
        parser.error("--audio is required unless --self-test is given")
    else:
        payload = None
    if payload is not None:
        print(MARKER + json.dumps(payload))
        return 0 if payload.get("ok") else 1
    try:
        payload = analyse(args.audio, args.max_seconds)
    except Exception as error:  # noqa: BLE001 - the caller needs one JSON error, not a traceback
        payload = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    print(MARKER + json.dumps(payload))
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
