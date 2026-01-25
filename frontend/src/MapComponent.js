/* global google */

import React, { useRef, useState } from 'react';
import { 
  GoogleMap, 
  useJsApiLoader, 
  DrawingManager, 
  Polygon 
} from '@react-google-maps/api';

const LIBRARIES = ['drawing', 'geometry'];

const containerStyle = {
  width: '100%',
  height: '100%' 
};

const defaultCenter = {
  lat: 51.1694,
  lng: 71.4491
};

const MapComponent = () => {
  const [openWeatherAirTemp, setOpenWeatherAirTemp] = useState(null);
  const [openWeatherSurfaceTemp, setOpenWeatherSurfaceTemp] = useState(null);
  const [airTemp, setAirTemp] = useState(null);
  const [soilTemp, setSoilTemp] = useState(null);
  const [polygon, setPolygon] = useState(null);
  const [polygonId, setPolygonId] = useState(null);
  const polygonCounterRef = useRef(0);
  const [area, setArea] = useState(0);
  const [drawingMode, setDrawingMode] = useState(null);  
  const [ndvi, setNdvi] = useState(null);  // Средний
  const [ndviMin, setNdviMin] = useState(null);  // Мин
  const [ndviMax, setNdviMax] = useState(null);  // Макс
  const [dailyNdvi, setDailyNdvi] = useState(null);  // Ежедневная сводка
  const [tiffDays, setTiffDays] = useState([]);  // Доступные дни для TIFF
  const [coords, setCoords] = useState(null);  // Координаты полигона (для TIFF)
  const [center, setCenter] = useState(defaultCenter);  // Динамический центр
  const [inputLat, setInputLat] = useState(defaultCenter.lat.toString());  // Input для lat
  const [inputLng, setInputLng] = useState(defaultCenter.lng.toString());  // Input для lng
  const [district, setDistrict] = useState('');
  const [filters, setFilters] = useState({  // Фильтры для backend
    dateStart: '2024-06-01',
    dateEnd: '2024-08-31',
    cloudPct: 20
  });
  const [summaryReady, setSummaryReady] = useState(false);
  const [bnsFile, setBnsFile] = useState(null);
  const [bnsResults, setBnsResults] = useState(null);
  const [bnsError, setBnsError] = useState(null);

  const BNS_MODEL_URL = 'http://localhost:8000/predict';

  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-map-script',  
    googleMapsApiKey: process.env.REACT_APP_GOOGLE_MAPS_API_KEY,
    libraries: LIBRARIES
  });

  // Функции для NDVI (внутри компонента)
  const getNDVIColor = (v) => {
    if (v === null) return 'orange';
    if (v >= 0.8) return '#006400';
    if (v >= 0.67) return '#228B22';
    if (v >= 0.4) return '#32CD32';
    if (v >= 0.2) return '#ADFF2F';
    if (v >= 0.09) return '#DEB887';
    if (v >= -0.1) return '#A9A9A9';
    if (v >= -0.33) return '#1E90FF';
    if (v >= -0.55) return '#808080';
    return '#FFA500';
  };

  const getNDVIText = (v) => {
    if (v === null) return 'Нет данных';
    if (v >= 0.8) return 'очень густая растительность';
    if (v >= 0.67) return 'густая растительность';
    if (v >= 0.4) return 'скудная древесная/кустарниковая растительность';
    if (v >= 0.2) return 'кустарники и пастбища';
    if (v >= 0.09) return 'открытая почва';
    if (v >= -0.1) return 'горные породы, песок, снег';
    if (v >= -0.33) return 'водный объект';
    if (v >= -0.55) return 'антропогенное покрытие';
    return 'облако';
  };

  // Функция центрирования по вводу (с кнопкой)
  const handleCenter = () => {
    const lat = parseFloat(inputLat);
    const lng = parseFloat(inputLng);

    // Валидация координат
    if (isNaN(lat) || lat < -90 || lat > 90) {
      alert('Широта должна быть от -90 до 90');
      return;
    }
    if (isNaN(lng) || lng < -180 || lng > 180) {
      alert('Долгота должна быть от -180 до 180');
      return;
    }

    setCenter({ lat, lng });
    console.log(`Карта центрирована на ${lat}, ${lng}`);
  };

  // Функция скачивания CSV
  const downloadCSV = (dailyData) => {
    if (!dailyData || dailyData.length === 0) {
      alert('Нет данных для скачивания');
      return;
    }

    let csvContent = 'date,ndvi_min,ndvi_mean,ndvi_max\n';
    dailyData.forEach(day => {
      csvContent += `${day.date},${day.ndvi_min || ''},${day.ndvi_mean || ''},${day.ndvi_max || ''}\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'ndvi_daily.csv';
    link.click();
  };

  // Функция скачивания TIFF по дню
  const downloadTIFF = async (day) => {
    if (!coords) {
      alert('Сначала нарисуйте полигон!');
      return;
    }

    try {
      const response = await fetch('http://localhost:5000/api/ndvi-tiff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day, coords, ...filters })
      });
      const data = await response.json();
      if (data.tiffUrl) {
        const link = document.createElement('a');
        link.href = data.tiffUrl;
        link.download = `ndvi_${day}.tiff`;
        link.click();
      } else {
        alert(data.error || 'Ошибка генерации TIFF');
      }
    } catch (error) {
      console.error('TIFF download error:', error);
      alert('Ошибка скачивания TIFF');
    }
  };

  const formatNumber = (value, decimals) => {
    if (value === null || value === undefined) {
      return '';
    }
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
      return '';
    }
    return numberValue.toFixed(decimals);
  };

  const downloadSummaryCSV = () => {
    if (!polygonId) {
      alert('No polygon selected.');
      return;
    }
    const year = filters.dateStart ? String(filters.dateStart).slice(0, 4) : '';
    const periodStart = filters.dateStart || '';
    const periodEnd = filters.dateEnd || '';
    const areaValue = area ? Number(area) : null;
    const header = [
      'polygon_id',
      'district',
      'year',
      'period_start',
      'period_end',
      'area_m2',
      'ndvi_mean',
      'ndvi_min',
      'ndvi_max',
      'gee_air_temp_mean',
      'gee_lst_day_mean',
      'ow_air_temp_last5d_mean',
      'ow_lst_last5d_mean'
    ].join(',');

    const data = [
      polygonId,
      district,
      year,
      periodStart,
      periodEnd,
      formatNumber(areaValue, 2),
      formatNumber(ndvi, 3),
      formatNumber(ndviMin, 3),
      formatNumber(ndviMax, 3),
      formatNumber(airTemp, 2),
      formatNumber(soilTemp, 2),
      formatNumber(openWeatherAirTemp, 2),
      formatNumber(openWeatherSurfaceTemp, 2)
    ].join(',');

    const blob = new Blob([`${header}\n${data}\n`], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${polygonId}_${year}_summary.csv`;
    link.click();
  };

  const runBnsModel = async () => {
    if (!bnsFile) {
      alert('Please choose a CSV file.');
      return;
    }

    const formData = new FormData();
    formData.append('file', bnsFile);

    try {
      setBnsError(null);
      const response = await fetch(BNS_MODEL_URL, {
        method: 'POST',
        body: formData
      });
      const data = await response.json();
      if (!response.ok || data.error) {
        throw new Error(data.error || 'BNS model error');
      }
      setBnsResults(data.records || []);
    } catch (error) {
      console.error('BNS model error:', error);
      setBnsResults(null);
      setBnsError(error.message || 'Failed to run BNS model');
    }
  };

  const onPolygonComplete = async (poly) => {
    setPolygon(poly);
    setSummaryReady(false);
    let ndviValue = null;
    let airTempValue = null;
    let soilTempValue = null;
    let openWeatherAirValue = null;
    let openWeatherSurfaceValue = null;
    const path = poly.getPath();
    const areaInSqMeters = google.maps.geometry.spherical.computeArea(path);
    setArea(areaInSqMeters.toFixed(2));
    const currentCoords = path.getArray().map(p => [p.lng(), p.lat()]);  // Сохраняем coords
    setCoords(currentCoords);
    setDrawingMode(null); 
    console.log(`Площадь: ${areaInSqMeters.toFixed(2)} м²`);

    // NDVI запрос
    try {
      const ndviResponse = await fetch('http://localhost:5000/api/ndvi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coords: currentCoords, ...filters })
      });
      const ndviData = await ndviResponse.json();
      setNdvi(ndviData.ndvi);
      setNdviMin(ndviData.ndviMin);
      setNdviMax(ndviData.ndviMax);
      ndviValue = ndviData.ndvi ?? null;
      console.log('NDVI from backend:', ndviData);
    } catch (error) {
      console.error('NDVI backend error:', error);
      setNdvi('Ошибка NDVI');
      ndviValue = null;
    }


    // Climate (GEE) temperatures
    try {
      const climateResponse = await fetch('http://localhost:5000/api/climate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coords: currentCoords, ...filters })
      });
      const climateData = await climateResponse.json();
      if (!climateResponse.ok) {
        throw new Error(climateData.error || 'Climate calculation failed');
      }
      setAirTemp(climateData.airTemp ?? null);
      setSoilTemp(climateData.soilTemp ?? null);
      airTempValue = climateData.airTemp ?? null;
      soilTempValue = climateData.soilTemp ?? null;
    } catch (error) {
      console.error('Climate backend error:', error);
      setAirTemp(null);
      setSoilTemp(null);
      airTempValue = null;
      soilTempValue = null;
    }

    // OpenWeather averages for the period
    try {
      const weatherResponse = await fetch('http://localhost:5000/api/openweather', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coords: currentCoords, ...filters })
      });
      const weatherData = await weatherResponse.json();
      if (!weatherResponse.ok) {
        throw new Error(weatherData.error || 'OpenWeather calculation failed');
      }
      setOpenWeatherAirTemp(weatherData.airTempAvg ?? null);
      setOpenWeatherSurfaceTemp(weatherData.surfaceTempAvg ?? null);
      openWeatherAirValue = weatherData.airTempAvg ?? null;
      openWeatherSurfaceValue = weatherData.surfaceTempAvg ?? null;
      console.log('OpenWeather from backend:', weatherData);
    } catch (error) {
      console.error('OpenWeather backend error:', error);
      setOpenWeatherAirTemp(null);
      setOpenWeatherSurfaceTemp(null);
    setAirTemp(null);
    setSoilTemp(null);
    openWeatherAirValue = null;
    openWeatherSurfaceValue = null;
    }

    // Daily NDVI запрос (для CSV и TIFF дней)
    try {
      const dailyResponse = await fetch('http://localhost:5000/api/ndvi-daily', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coords: currentCoords, ...filters })
      });
      const dailyData = await dailyResponse.json();
      setDailyNdvi(dailyData.daily || []);
      // TIFF дни — только с ndvi_mean !== null
      setTiffDays(dailyData.daily ? dailyData.daily.filter(day => day.ndvi_mean !== null) : []);
      console.log('Daily NDVI from backend:', dailyData);
    } catch (error) {
      console.error('Daily NDVI backend error:', error);
      setDailyNdvi([]);
      setTiffDays([]);
    } finally {
      const summaryIsReady =
        ndviValue !== null && Number.isFinite(Number(ndviValue)) &&
        airTempValue !== null && Number.isFinite(Number(airTempValue)) &&
        soilTempValue !== null && Number.isFinite(Number(soilTempValue)) &&
        openWeatherAirValue !== null && Number.isFinite(Number(openWeatherAirValue)) &&
        openWeatherSurfaceValue !== null && Number.isFinite(Number(openWeatherSurfaceValue));
      setSummaryReady(summaryIsReady);
    }
  };

  const startDrawing = () => {
    if (polygon) {
      polygon.setMap(null);  
    }
    polygonCounterRef.current += 1;
    setPolygonId(`poly_${String(polygonCounterRef.current).padStart(3, '0')}`);
    setPolygon(null);
    setArea(0);
    setNdvi(null);
    setNdviMin(null);
    setNdviMax(null);
    setDailyNdvi(null);
    setTiffDays([]);
    setCoords(null);
    setOpenWeatherAirTemp(null);
    setOpenWeatherSurfaceTemp(null);
    setAirTemp(null);
    setSoilTemp(null);
    setSummaryReady(false);
    setDrawingMode(google.maps.drawing.OverlayType.POLYGON);  
  };

  if (loadError) {
    return (
      <div style={{ color: 'red', padding: '20px' }}>
        Ошибка загрузки карты: {loadError.message}.
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        Загрузка Google Maps API...
      </div>
    );
  }

  return (
    <div className="main-layout">
      {/* Левый боковое меню */}
      <div className="sidebar">
        <div className="sidebar-section">
          <h3>Координаты</h3>
          <label>Широта (lat):</label>
          <input
            type="number"
            value={inputLat}
            onChange={(e) => setInputLat(e.target.value)}  // Только обновляет input
            step="any"
            min="-90"
            max="90"
          />
          <label>Долгота (lng):</label>
          <input
            type="number"
            value={inputLng}
            onChange={(e) => setInputLng(e.target.value)}  // Только обновляет input
            step="any"
            min="-180"
            max="180"
          />
          <button onClick={handleCenter}>Применить координаты</button>
        </div>

        <div className="sidebar-section">
          <h3>Дата</h3>
          <label>Начало:</label>
          <input
            type="date"
            value={filters.dateStart}
            onChange={(e) => setFilters({ ...filters, dateStart: e.target.value })}
          />
          <label>Конец:</label>
          <input
            type="date"
            value={filters.dateEnd}
            onChange={(e) => setFilters({ ...filters, dateEnd: e.target.value })}
          />
        </div>

        <div className="sidebar-section">
          <h3>Район (по данным БНС)</h3>
          <label>Название района:</label>
          <input
            type="text"
            value={district}
            onChange={(e) => setDistrict(e.target.value)}
            placeholder="например, Атбасарский район"
          />
        </div>

        <div className="sidebar-section">
          <h3>Облачность (%)</h3>
          <div className="slider-container">
            <label>{filters.cloudPct}%</label>
            <input
              type="range"
              min="0"
              max="100"
              value={filters.cloudPct}
              onChange={(e) => setFilters({ ...filters, cloudPct: parseInt(e.target.value) })}
            />
          </div>
        </div>

        <div className="sidebar-section">
          <button onClick={startDrawing} disabled={!!drawingMode}>Рисовать полигон</button>
        </div>
      </div>

      {/* Центральная карта */}
      <div className="map-container">
        <GoogleMap
          mapContainerStyle={containerStyle}
          center={center}
          zoom={13}
          mapTypeControl={false}
          fullscreenControl={false}
          streetViewControl={false}
          rotateControl={false}
          zoomControl={true} 
        >
          <DrawingManager
            onPolygonComplete={onPolygonComplete}
            drawingMode={drawingMode} 
            options={{
              drawingControl: false,  
              polygonOptions: {
                editable: true,
                strokeColor: '#FF0000',
                fillColor: '#FF000033',
                strokeWeight: 2
              }
            }}
          />
          {polygon && (
            <Polygon
              path={polygon.getPath()}
              options={{
                editable: true,
                strokeColor: '#FF0000',
                fillColor: '#FF000033',
                strokeWeight: 2
              }}
            />
          )}
        </GoogleMap>
      </div>

      {/* Правый сайдбар — результаты */}
      <div className="results-sidebar">
        <div className="results-section">
          <h3>Результаты</h3>
          {area > 0 && (
            <div className="results-item">
              Площадь: {area} м²
            </div>
          )}
          {ndvi !== null && (
            <div>
              <div className="results-item" style={{ color: getNDVIColor(ndvi) }}>
                NDVI средний: {ndvi.toFixed(3)} ({getNDVIText(ndvi)})
              </div>
              {ndviMin !== null && (
                <div className="results-item" style={{ color: getNDVIColor(ndviMin) }}>
                  NDVI мин: {ndviMin.toFixed(3)}
                </div>
              )}
              {ndviMax !== null && (
                <div className="results-item" style={{ color: getNDVIColor(ndviMax) }}>
                  NDVI макс: {ndviMax.toFixed(3)}
                </div>
              )}
            </div>
          )}
          {airTemp !== null && (
            <div className="results-item">
              {`GEE Температура воздуха (средняя за период): ${airTemp.toFixed(2)}°C`}
            </div>
          )}
          {soilTemp !== null && (
            <div className="results-item">
              {`GEE Температура поверхности (дневная, средняя за период): ${soilTemp.toFixed(2)}°C`}
            </div>
          )}
          {openWeatherAirTemp !== null && (
            <div className="results-item">
              {`OpenWeather Температура воздуха (последние 5 дней): ${openWeatherAirTemp.toFixed(2)}°C`}
            </div>
          )}
          {openWeatherSurfaceTemp !== null && (
            <div className="results-item">
              {`OpenWeather Температура поверхности (последние 5 дней): ${openWeatherSurfaceTemp.toFixed(2)}°C`}
            </div>
          )}
          {polygonId && summaryReady && (
            <div className="results-item">
              <button
                onClick={downloadSummaryCSV}
                style={{ width: '100%', padding: '8px', backgroundColor: '#2ecc71', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
              >
                Скачать CSV датасет (NDVI, температура)
              </button>
            </div>
          )}
{dailyNdvi && dailyNdvi.length > 0 && (
            <div className="results-item">
              <button onClick={() => downloadCSV(dailyNdvi)} style={{ width: '100%', padding: '8px', backgroundColor: '#3498db', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                Скачать сводку по NDVI (доступные дни)
              </button>
            </div>
          )}
          {tiffDays && tiffDays.length > 0 && (
            <div className="results-section">
              <h4>TIFF NDVI (доступные дни)</h4>
              {tiffDays.map((day) => (
                <div key={day.date} className="results-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>{day.date}</span>
                  <button onClick={() => downloadTIFF(day.date)} style={{ padding: '4px 8px', backgroundColor: '#3498db', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer', fontSize: '12px' }}>
                    Скачать TIFF
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="results-section">
            <h4>Прогноз урожайности (модель БНС)</h4>
            <div className="results-item">
              <input
                type="file"
                accept=".csv"
                onChange={(e) => {
                  setBnsFile(e.target.files && e.target.files[0] ? e.target.files[0] : null);
                  setBnsResults(null);
                  setBnsError(null);
                }}
              />
            </div>
            <div className="results-item">
              <button
                onClick={runBnsModel}
                disabled={!bnsFile}
                style={{ width: '100%', padding: '8px', backgroundColor: '#1abc9c', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
              >
                Рассчитать урожайность
              </button>
            </div>
            {bnsError && (
              <div className="results-item" style={{ color: 'red' }}>
                {bnsError}
              </div>
            )}
            {bnsResults && bnsResults.length > 0 && (
              <div className="results-item">
                {bnsResults.map((row, index) => (
                  <div key={`${row.district || 'row'}-${row.year || index}`} style={{ marginBottom: '6px' }}>
                    <div>{`Район: ${row.district || ''}`}</div>
                    <div>{`Год: ${row.year || ''}`}</div>
                    <div>{`Базовый прогноз (ML по БНС): ${formatNumber(row.yield_pred_base_t_ha, 3)} т/га`}</div>
                    <div>{`Корректировка (NDVI+темп.): ${formatNumber(row.yield_adjustment_t_ha, 3)} т/га`}</div>
                    <div>{`Итоговый прогноз: ${formatNumber(row.yield_pred_t_ha, 3)} т/га`}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MapComponent;
