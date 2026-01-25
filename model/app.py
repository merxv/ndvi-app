# app.py
from __future__ import annotations

import io
import os

import pandas as pd
from fastapi import FastAPI, File, UploadFile
import math
from fastapi.middleware.cors import CORSMiddleware

from bns_model import (
    load_bns_long_csv,
    load_automl_model,
    attach_lags_for_prediction,
    apply_mvp_adjustment,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.getenv(
    "BNS_LONG_CSV",
    os.path.join(BASE_DIR, "data", "bns_yield_2004_2024_long.csv"),
)
MODEL_PATH = os.getenv(
    "AUTOML_MODEL_PATH",
    os.path.join(BASE_DIR, "autogluon_bns_model"),
)

app = FastAPI(title="Yield Service (BNS baseline + NDVI adjustment)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BNS_HIST = load_bns_long_csv(DATA_PATH)
BASELINE_MODEL = load_automl_model(MODEL_PATH)

@app.get("/health")
def health():
    return {"status": "ok", "bns_rows": len(BNS_HIST)}

@app.post("/predict")
async def predict(file: UploadFile = File(...), mvp_adjust: bool = True):
    """
    Принимает CSV с полигонами.
    Требует: district, year + твои поля NDVI/темп (для корректировки, опционально)
    Возвращает records с yield_pred_base_t_ha и yield_pred_t_ha.
    """
    content = await file.read()
    df = pd.read_csv(io.BytesIO(content))

    # district
    if "district" not in df.columns:
        return {"error": "CSV must include 'district' column (e.g. 'Целиноградский район')."}

    
    df["year"] = pd.to_numeric(df["year"], errors="coerce")
    df = df.dropna(subset=["year"]).copy()
    df["year"] = df["year"].astype(int)

    df2 = attach_lags_for_prediction(BNS_HIST, df)

    # baseline prediction
    needed_cols = ["district", "year", "yield_lag1", "yield_lag2", "yield_roll3"]
    df2["yield_pred_base_t_ha"] = BASELINE_MODEL.predict(df2[needed_cols]).astype(float)

    # optional MVP adjustment using NDVI/temp
    if mvp_adjust:
        df2 = apply_mvp_adjustment(df2)
    else:
        df2["yield_pred_t_ha"] = df2["yield_pred_base_t_ha"]

    # FastAPI JSON can't serialize NaN/inf, replace with None
    records = df2.to_dict(orient="records")

    def sanitize(value):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value

    def sanitize_record(record):
        return {key: sanitize(val) for key, val in record.items()}

    clean_records = [sanitize_record(rec) for rec in records]

    return {
        "n_rows": len(clean_records),
        "records": clean_records,
    }
