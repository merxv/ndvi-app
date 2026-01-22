# bns_model.py
from __future__ import annotations

import numpy as np
import pandas as pd

from sklearn.pipeline import Pipeline
from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import OneHotEncoder
from sklearn.impute import SimpleImputer
from sklearn.ensemble import HistGradientBoostingRegressor


def load_bns_long_csv(path: str) -> pd.DataFrame:
    """
    Ожидает колонки: district, year, yield_c_per_ha
    (как в твоём bns_yield_2004_2024_long.csv)
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

    # перевод в т/га
    df["yield_t_ha"] = df["yield_c_per_ha"] / 10.0
    df["year"] = df["year"].astype(int)

    # лаги/роллинг (без утечки: shift(1))
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


def train_baseline_model(bns_df: pd.DataFrame) -> Pipeline:
    """
    Baseline ML: district + year + лаги -> yield_t_ha
    """
    categorical = ["district"]
    numeric = ["year", "yield_lag1", "yield_lag2", "yield_roll3"]

    pre = ColumnTransformer(
        transformers=[
            ("cat", Pipeline(steps=[
                ("imp", SimpleImputer(strategy="most_frequent")),
                ("oh", OneHotEncoder(handle_unknown="ignore", sparse_output=False)),  # dense!
            ]), categorical),
            ("num", Pipeline(steps=[
                ("imp", SimpleImputer(strategy="median")),
            ]), numeric),
        ],
        remainder="drop",
    )

    model = HistGradientBoostingRegressor(
        random_state=42,
        max_depth=6,
        learning_rate=0.08,
        max_iter=600,
    )

    pipe = Pipeline(steps=[("pre", pre), ("model", model)])
    pipe.fit(bns_df, bns_df["yield_t_ha"])
    return pipe


def attach_lags_for_prediction(bns_hist: pd.DataFrame, poly_df: pd.DataFrame) -> pd.DataFrame:
    """
    poly_df должен содержать district и year (например 2026).
    Мы приклеиваем эти строки к истории и считаем lag1/lag2/roll3.
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

    # вернуть только строки для предикта (где yield_t_ha пустая)
    pred_rows = comb[comb["yield_t_ha"].isna()][["district", "year", "yield_lag1", "yield_lag2", "yield_roll3"]]
    out = poly_df.merge(pred_rows, on=["district", "year"], how="left")
    return out


def apply_mvp_adjustment(poly_df: pd.DataFrame) -> pd.DataFrame:
    """
    MVP корректировка по NDVI/температуре как у тебя в Colab.
    Можно выключить, если не нужно.
    """
    out = poly_df.copy()

    # derived
    if "ndvi_range" not in out.columns and {"ndvi_max", "ndvi_min"} <= set(out.columns):
        out["ndvi_range"] = pd.to_numeric(out["ndvi_max"], errors="coerce") - pd.to_numeric(out["ndvi_min"], errors="coerce")

    # коэффициенты
    k_ndvi = 0.6
    k_temp = 0.02

    ndvi_mean = pd.to_numeric(out.get("ndvi_mean"), errors="coerce")
    gee_air = pd.to_numeric(out.get("gee_air_temp_mean"), errors="coerce")

    ndvi_effect = k_ndvi * (ndvi_mean - 0.2)  # 0.2 — условный baseline
    temp_effect = k_temp * gee_air

    # ограничим влияние, чтобы не улетало
    adj = (ndvi_effect.fillna(0) + temp_effect.fillna(0)).clip(-0.5, 0.5)
    out["yield_adjustment_t_ha"] = adj
    out["yield_pred_t_ha"] = out["yield_pred_base_t_ha"] + out["yield_adjustment_t_ha"]

    return out
