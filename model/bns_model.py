# bns_model.py
from __future__ import annotations

import numpy as np
import pandas as pd

from autogluon.tabular import TabularPredictor


def load_bns_long_csv(path: str) -> pd.DataFrame:
    """
    Expected columns: district, year, yield_c_per_ha
    """
    df = pd.read_csv(path)
    required = {"district", "year", "yield_c_per_ha"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"BNS long csv missing columns: {sorted(missing)}")

    df["district"] = df["district"].astype(str).str.strip()
    df["year"] = pd.to_numeric(df["year"], errors="coerce").astype("Int64")
    df["yield_c_per_ha"] = pd.to_numeric(df["yield_c_per_ha"], errors="coerce")
    df = df.dropna(subset=["district", "year", "yield_c_per_ha"]).copy()

    # convert to t/ha
    df["yield_t_ha"] = df["yield_c_per_ha"] / 10.0
    df["year"] = df["year"].astype(int)

    # lags/rolling (no leakage: shift(1))
    df = df.sort_values(["district", "year"]).reset_index(drop=True)
    df["yield_lag1"] = df.groupby("district")["yield_t_ha"].shift(1)
    df["yield_lag2"] = df.groupby("district")["yield_t_ha"].shift(2)
    df["yield_roll3"] = (
        df.groupby("district")["yield_t_ha"]
          .shift(1)
          .rolling(3, min_periods=1)
          .mean()
          .reset_index(level=0, drop=True)
    )
    return df


def train_automl_model(
    bns_df: pd.DataFrame,
    save_path: str = "autogluon_bns_model",
    presets: str = "medium_quality",
    time_limit: float | None = None,
) -> TabularPredictor:
    """
    AutoML: district + year + lags -> yield_t_ha (regression)
    """
    feature_cols = ["district", "year", "yield_lag1", "yield_lag2", "yield_roll3"]
    target_col = "yield_t_ha"

    train_data = bns_df[feature_cols + [target_col]].copy()

    predictor = TabularPredictor(
        label=target_col,
        problem_type="regression",
        path=save_path,
    ).fit(
        train_data=train_data,
        presets=presets,
        time_limit=time_limit,
    )

    return predictor


def load_automl_model(path: str) -> TabularPredictor:
    return TabularPredictor.load(path)


def attach_lags_for_prediction(bns_hist: pd.DataFrame, poly_df: pd.DataFrame) -> pd.DataFrame:
    """
    poly_df must contain district and year. We append rows to history and compute lag1/lag2/roll3.
    """
    need = {"district", "year"}
    missing = need - set(poly_df.columns)
    if missing:
        raise ValueError(f"Polygon dataset missing columns: {sorted(missing)}")

    base = bns_hist[["district", "year", "yield_t_ha"]].copy()
    tmp = poly_df[["district", "year"]].copy()
    tmp["yield_t_ha"] = np.nan

    comb = pd.concat([base, tmp], ignore_index=True)
    comb["district"] = comb["district"].astype(str).str.strip()
    comb["year"] = pd.to_numeric(comb["year"], errors="coerce")
    comb = comb.dropna(subset=["district", "year"]).copy()
    comb["year"] = comb["year"].astype(int)

    comb = comb.sort_values(["district", "year"]).reset_index(drop=True)

    comb["yield_lag1"] = comb.groupby("district")["yield_t_ha"].shift(1)
    comb["yield_lag2"] = comb.groupby("district")["yield_t_ha"].shift(2)
    comb["yield_roll3"] = (
        comb.groupby("district")["yield_t_ha"]
            .shift(1)
            .rolling(3, min_periods=1)
            .mean()
            .reset_index(level=0, drop=True)
    )

    # return only prediction rows (yield_t_ha is NaN)
    pred_rows = comb[comb["yield_t_ha"].isna()][["district", "year", "yield_lag1", "yield_lag2", "yield_roll3"]]
    out = poly_df.merge(pred_rows, on=["district", "year"], how="left")
    return out


def apply_mvp_adjustment(poly_df: pd.DataFrame) -> pd.DataFrame:
    """
    MVP adjustment using NDVI/temperature.
    """
    out = poly_df.copy()

    # derived
    if "ndvi_range" not in out.columns and {"ndvi_max", "ndvi_min"} <= set(out.columns):
        out["ndvi_range"] = pd.to_numeric(out["ndvi_max"], errors="coerce") - pd.to_numeric(out["ndvi_min"], errors="coerce")

    # coefficients
    k_ndvi = 0.6
    k_temp = 0.02

    ndvi_mean = pd.to_numeric(out.get("ndvi_mean"), errors="coerce")
    gee_air = pd.to_numeric(out.get("gee_air_temp_mean"), errors="coerce")

    ndvi_effect = k_ndvi * (ndvi_mean - 0.2)  # 0.2 is a baseline
    temp_effect = k_temp * gee_air

    # clamp adjustment
    adj = (ndvi_effect.fillna(0) + temp_effect.fillna(0)).clip(-0.5, 0.5)
    out["yield_adjustment_t_ha"] = adj
    out["yield_pred_t_ha"] = out["yield_pred_base_t_ha"] + out["yield_adjustment_t_ha"]

    return out
