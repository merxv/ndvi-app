# app.py
from __future__ import annotations

import io
import os
from functools import lru_cache

import pandas as pd
import numpy as np
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


def _sanitize_value(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if value is pd.NA:
        return None
    try:
        if pd.isna(value):
            return None
    except TypeError:
        pass
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    return value


def _sanitize_record(record: dict) -> dict:
    return {key: _sanitize_value(val) for key, val in record.items()}


def _build_model_report() -> dict:
    summary = BASELINE_MODEL.fit_summary(verbosity=0)
    feature_cols = ["district", "year", "yield_lag1", "yield_lag2", "yield_roll3"]
    eval_df = BNS_HIST[feature_cols + ["yield_t_ha"]].dropna().copy()

    errors = []
    best_model = None
    try:
        best_model = BASELINE_MODEL.get_model_best()
    except Exception:
        best_model = summary.get("model_best")
    eval_metric = summary.get("eval_metric")
    if not eval_metric:
        try:
            eval_metric = getattr(BASELINE_MODEL.eval_metric, "name", BASELINE_MODEL.eval_metric)
        except Exception:
            eval_metric = None
    try:
        model_names = BASELINE_MODEL.get_model_names()
        num_models_trained = len(model_names)
    except Exception:
        num_models_trained = summary.get("num_models_trained")
    if not num_models_trained:
        try:
            info = BASELINE_MODEL.info()
        except Exception:
            info = {}
        num_models_trained = info.get("num_models_trained") or len(info.get("model_info", {}) or {})
    try:
        metrics = BASELINE_MODEL.evaluate(eval_df, silent=True, auxiliary_metrics=True)
    except Exception as exc:
        metrics = {}
        errors.append(f"metrics_error: {exc}")

    leaderboard = None
    try:
        leaderboard = BASELINE_MODEL.leaderboard(eval_df, silent=True)
        if "score_val" in leaderboard.columns:
            leaderboard = leaderboard.sort_values("score_val", ascending=False)
        leaderboard = leaderboard.head(5)
        leaderboard_records = [
            _sanitize_record(rec) for rec in leaderboard.to_dict(orient="records")
        ]
    except Exception as exc:
        leaderboard_records = []
        errors.append(f"leaderboard_error: {exc}")

    best_model_stack_level = summary.get("model_best_stack_level")
    num_stack_levels = summary.get("num_stack_levels")
    if leaderboard is not None and "stack_level" in leaderboard.columns:
        try:
            num_stack_levels = int(leaderboard["stack_level"].max())
        except Exception:
            pass
        if not best_model_stack_level and best_model:
            try:
                match = leaderboard[leaderboard["model"] == best_model]
                if not match.empty:
                    best_model_stack_level = int(match["stack_level"].iloc[0])
            except Exception:
                pass

    total_train_time_seconds = summary.get("total_time")
    if total_train_time_seconds is None:
        total_train_time_seconds = summary.get("total_time_seconds")
    if total_train_time_seconds is None:
        total_train_time_seconds = summary.get("time_fit_s") or summary.get("total_fit_time")
    if total_train_time_seconds is None:
        try:
            info = BASELINE_MODEL.info()
        except Exception:
            info = {}
        total_train_time_seconds = info.get("time_fit_s") or info.get("total_time") or info.get("total_fit_time")
    if total_train_time_seconds is None and leaderboard is not None and "fit_time" in leaderboard.columns:
        try:
            total_train_time_seconds = float(leaderboard["fit_time"].sum())
        except Exception:
            pass

    return {
        "automl": {
            "best_model": best_model or summary.get("model_best"),
            "best_model_stack_level": best_model_stack_level,
            "num_models_trained": num_models_trained,
            "num_stack_levels": num_stack_levels,
            "eval_metric": eval_metric,
            "total_train_time_seconds": total_train_time_seconds,
            "selection_note": "Best model chosen by validation score on eval_metric.",
        },
        "metrics": _sanitize_record(metrics),
        "leaderboard": leaderboard_records,
        "errors": errors,
    }


@lru_cache(maxsize=1)
def _get_model_report_cached() -> dict:
    return _build_model_report()

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

    clean_records = [_sanitize_record(rec) for rec in records]

    return {
        "n_rows": len(clean_records),
        "records": clean_records,
    }


@app.get("/model-info")
def model_info(refresh: bool = False):
    if refresh:
        _get_model_report_cached.cache_clear()
    return _get_model_report_cached()
