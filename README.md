# NDVI Analyzer

Веб‑приложение для расчёта NDVI по полигону на карте с помощью Google Earth Engine, а также для получения средних температур (GEE + OpenWeather) и выгрузки дневных NDVI/GeoTIFF. Дополнительно есть отдельный сервис прогнозирования урожайности (BNS) на FastAPI.

## Состав проекта

- `frontend/` — React‑приложение с картой Google Maps и UI.
- `backend/` — Node.js/Express API для NDVI/климата/OWM.
- `model/` — FastAPI сервис для прогноза урожайности по CSV.

## Требования

- Node.js 18+
- npm 9+
- Python 3.11 (для AutoGluon)
- Аккаунт Google Earth Engine + Service Account key (JSON)
- Ключ OpenWeather API
- Ключ Google Maps JavaScript API

## Настройка

### 1) Backend (Google Earth Engine + OpenWeather)

Создайте `backend/.env` по примеру `backend/.env.example`:

```
GOOGLE_CLOUD_PROJECT=
GEE_PRIVATE_KEY_PATH=./config.example.json
OPENWEATHER_API_KEY=
```

- `GEE_PRIVATE_KEY_PATH` — путь к JSON‑ключу Service Account (пример структуры в `backend/config.example.json`).
- `OPENWEATHER_API_KEY` — ключ OpenWeather.

### 2) Frontend (Google Maps)

Создайте `frontend/.env` по примеру `frontend/.env.example`:

```
REACT_APP_GOOGLE_MAPS_API_KEY=
```

### 3) Model (BNS, AutoML)

Модель обучается отдельно через AutoGluon и затем только загружается в FastAPI.

Переменные окружения (опционально):

```
BNS_LONG_CSV=data/bns_yield_2004_2024_long.csv
AUTOML_MODEL_PATH=model/autogluon_bns_model
```

## Установка зависимостей

```
# backend
cd backend
npm install

# frontend
cd ..\frontend
npm install

# model (AutoML)
cd ..\model
py -3.11 -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

## Запуск

В разных терминалах:

```
# backend API
cd backend
node server.js
```

```
# frontend
cd frontend
npm start
```

```
# model (AutoML)
cd model
.\.venv\Scripts\activate
python train_automl.py
uvicorn app:app --reload --port 8000
```

По умолчанию:

- Frontend: http://localhost:3000
- Backend API: http://localhost:5000
- Model API: http://localhost:8000

## Backend API

Все запросы ожидают `coords` как массив вершин полигона в формате `[[lng, lat], ...]`.

- `POST /api/ndvi`
  - body: `{ coords, dateStart?, dateEnd?, cloudPct? }`
  - ответ: `{ ndvi, ndviMin, ndviMax }`

- `POST /api/ndvi-daily`
  - body: `{ coords, dateStart?, dateEnd?, cloudPct? }`
  - ответ: `{ daily: [{ date, ndvi_min, ndvi_mean, ndvi_max }, ...] }`

- `POST /api/ndvi-tiff`
  - body: `{ day, coords, cloudPct? }`
  - ответ: `{ tiffUrl }`

- `POST /api/climate`
  - body: `{ coords, dateStart?, dateEnd? }`
  - ответ: `{ airTemp, soilTemp }`

- `POST /api/openweather`
  - body: `{ coords }`
  - ответ: `{ airTempAvg, surfaceTempAvg }`

По умолчанию в UI используются даты `2024-06-01`…`2024-08-31` и `cloudPct = 20`.

## Model API (BNS, AutoML)

- `GET /health`
- `POST /predict` (multipart/form-data, поле `file` с CSV)

CSV должен содержать минимум колонки `district` и `year`.
Если в CSV есть столбцы `ndvi_mean`, `ndvi_min`, `ndvi_max`, `gee_air_temp_mean`, сервис применит MVP‑корректировку урожайности.
AutoML использует только признаки из BNS: `district`, `year`, `yield_lag1`, `yield_lag2`, `yield_roll3`.

## Примечания

- Backend использует Google Earth Engine (`@google/earthengine`) и требует корректный Service Account JSON.
- OpenWeather бесплатный прогноз не даёт температуру поверхности, поэтому используется `feels_like` как прокси.
- Для выгрузки GeoTIFF используется `getThumbURL` с ограничением `1024x1024`.

## Быстрый сценарий

1. Запустите backend и frontend.
2. Укажите ключи API в `.env`.
3. На карте нарисуйте полигон, получите NDVI/температуры, выгрузите CSV или TIFF.
4. (Опционально) запустите модель и загрузите CSV для прогноза урожайности.
