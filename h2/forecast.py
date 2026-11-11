"""
h2/forecast.py — TimesFM 2.5 zero-shot forecasts for pre-registered Hypothesis 2.

Reads calibration-only candles exported by h2/export_candles.js and writes quantile forecasts
at the pre-registered signal slots. No fine-tuning, no parameter search. Fixed config only
(see docs/hypothesis_2_preregistration.md + Addendum 1).

Usage:  ~/.venvs/h2-timesfm/bin/python h2/forecast.py
"""
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import torch
import timesfm

HERE = os.path.dirname(os.path.abspath(__file__))
IN_FILE = os.path.join(HERE, "data", "candles_calibration.json")
OUT_FILE = os.path.join(HERE, "data", "forecasts_calibration.json")

# ---- Pre-registered constants (DO NOT CHANGE) ----
CONTEXT = 512
HORIZON = 12
SLOT_FIRST, SLOT_LAST, SLOT_STEP = 12, 66, 6      # zero-based session bar indices
BATCH = 64
IST = timezone(timedelta(hours=5, minutes=30))


def session_index(times_ms):
    """Zero-based bar index within each IST trading day, keyed off the 09:15 bar."""
    idx, last_day, n = [], None, -1
    for t in times_ms:
        d = datetime.fromtimestamp(t / 1000, IST).date()
        if d != last_day:
            last_day, n = d, -1
        n += 1
        idx.append(n)
    return idx


def main():
    if "--final" in sys.argv or os.environ.get("EVALUATE_HOLDOUT") == "true":
        sys.exit("H2 forecast refuses --final: calibration data only.")

    raw = open(IN_FILE, "rb").read()
    in_hash = hashlib.sha256(raw).hexdigest()
    data = json.loads(raw)

    torch.set_float32_matmul_precision("high")
    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch")
    model.compile(
        timesfm.ForecastConfig(
            max_context=CONTEXT,
            max_horizon=HORIZON,
            normalize_inputs=True,
            use_continuous_quantile_head=True,
            infer_is_positive=True,
            fix_quantile_crossing=True,
        )
    )

    result, total = {}, 0
    t0 = time.time()
    for sym, rows in data.items():
        times = [r[0] for r in rows]
        closes = np.asarray([r[4] for r in rows], dtype=np.float64)
        sidx = session_index(times)
        slots = [
            i for i in range(len(rows))
            if SLOT_FIRST <= sidx[i] <= SLOT_LAST
            and (sidx[i] - SLOT_FIRST) % SLOT_STEP == 0
            and i + 1 >= CONTEXT          # full 512-close context required
        ]
        out = []
        for b in range(0, len(slots), BATCH):
            chunk = slots[b:b + BATCH]
            # context ends AT the signal bar close (inclusive): no future bars
            inputs = [closes[i - CONTEXT + 1:i + 1] for i in chunk]
            point, quant = model.forecast(horizon=HORIZON, inputs=inputs)
            point, quant = np.asarray(point), np.asarray(quant)
            for k, i in enumerate(chunk):
                q = quant[k, HORIZON - 1, :]          # [mean, P10..P90]
                out.append({
                    "i": int(i), "time": int(times[i]), "close": float(closes[i]),
                    "point12": float(point[k, HORIZON - 1]),
                    "mean12": float(q[0]), "q10": float(q[1]), "q50": float(q[5]), "q90": float(q[9]),
                })
        result[sym] = out
        total += len(out)
        print(f"  {sym:<10} {len(out):>5} forecasts  ({time.time() - t0:.0f}s elapsed)", flush=True)

    meta = {
        "model": "google/timesfm-2.5-200m-pytorch",
        "torch": torch.__version__,
        "context": CONTEXT, "horizon": HORIZON,
        "slots": [SLOT_FIRST, SLOT_LAST, SLOT_STEP],
        "input_sha256": in_hash,
        "total_forecasts": total,
        "created": datetime.now(IST).isoformat(),
    }
    json.dump({"meta": meta, "forecasts": result}, open(OUT_FILE, "w"))
    print(f"\nWrote {OUT_FILE}  total={total}\nInput SHA-256: {in_hash}")


if __name__ == "__main__":
    main()
