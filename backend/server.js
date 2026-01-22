const express = require('express');
const cors = require('cors');
const ee = require('@google/earthengine');
const path = require('path');
const https = require('https');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;

const fetchJson = (url) => new Promise((resolve, reject) => {
  https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`OpenWeather status ${res.statusCode}: ${data}`));
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
  }).on('error', reject);
});

// ===============================
// 🔐 Earth Engine authentication
// ===============================
const privateKey = require(path.resolve(process.env.GEE_PRIVATE_KEY_PATH));

ee.data.authenticateViaPrivateKey(
  privateKey,
  () => {
    ee.initialize();
    console.log('✅ Earth Engine initialized');
  },
  (err) => {
    console.error('❌ EE auth failed:', err);
  }
);

// ===============================
// 📡 NDVI endpoint (твой старый, не трогаем)
// ===============================
app.post('/api/ndvi', async (req, res) => {
  try {
    const { coords, dateStart = '2024-06-01', dateEnd = '2024-08-31', cloudPct = 20 } = req.body;

    if (!coords || coords.length < 3) {
      return res.status(400).json({ error: 'Invalid polygon' });
    }

    const geometry = ee.Geometry.Polygon([coords]);

    const ndviImage = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(geometry)
      .filterDate(dateStart, dateEnd)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', cloudPct))
      .median()
      .normalizedDifference(['B8', 'B4'])
      .rename('ndvi');

    const stats = ndviImage.reduceRegion({
      reducer: ee.Reducer.minMax().combine({
        reducer2: ee.Reducer.mean(),
        sharedInputs: true
      }),
      geometry,
      scale: 10,
      maxPixels: 1e9
    });

    const ndviStats = await stats.getInfo();
    console.log('Raw NDVI stats:', ndviStats);

    const ndviMin = ndviStats.ndvi_min || null;
    const ndviMax = ndviStats.ndvi_max || null;
    const ndviMean = ndviStats.ndvi_mean || null;

    if (ndviMean === null) {
      return res.json({ ndvi: null, ndviMin: null, ndviMax: null, message: 'No NDVI data' });
    }

    res.json({ 
      ndvi: ndviMean, 
      ndviMin, 
      ndviMax 
    });

  } catch (err) {
    console.error('❌ NDVI error:', err);
    res.status(500).json({ error: 'NDVI calculation failed' });
  }
});

// ===============================
// Climate endpoint (air/surface temperature from GEE)
// ===============================
app.post('/api/climate', async (req, res) => {
  try {
    const { coords, dateStart = '2024-06-01', dateEnd = '2024-08-31'} = req.body;

    if (!coords || coords.length < 3) {
      return res.status(400).json({ error: 'Invalid polygon' });
    }

    const geometry = ee.Geometry.Polygon([coords]);

    const airTempCollection = ee.ImageCollection('ECMWF/ERA5_LAND/HOURLY')
      .filterBounds(geometry)
      .filterDate(dateStart, dateEnd)
      .select('temperature_2m')
      .map(img => img.subtract(273.15))
      .mean();

    const airTempStats = airTempCollection.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry,
      scale: 10000,
      maxPixels: 1e9
    });

    const airTempInfo = await airTempStats.getInfo();
    let airTempValue = airTempInfo.temperature_2m;
    if (airTempValue === undefined || airTempValue === null) {
      airTempValue = null;
    }

    const soilTempIC = ee.ImageCollection('MODIS/061/MOD11A1')
      .filterBounds(geometry)
      .filterDate(dateStart, dateEnd)
      .select('LST_Day_1km');

    const soilTempImage = soilTempIC
      .map(img => img.multiply(0.02).subtract(273.15))
      .mean();

    const soilTempStats = soilTempImage.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry,
      scale: 1000,
      maxPixels: 1e9
    });

    const soilTempInfo = await soilTempStats.getInfo();
    const soilTempValue = soilTempInfo?.LST_Day_1km ?? null;

    res.json({
      airTemp: airTempValue,
      soilTemp: soilTempValue
    });
  } catch (err) {
    console.error('Climate error:', err);
    res.status(500).json({ error: 'Climate calculation failed' });
  }
});

// ===============================
// OpenWeather endpoint (avg air/surface temps for period)
// ===============================
app.post('/api/openweather', async (req, res) => {
  try {
    const { coords } = req.body;

    if (!OPENWEATHER_API_KEY) {
      return res.status(500).json({ error: 'Missing OpenWeather API key' });
    }

    if (!coords || coords.length < 3) {
      return res.status(400).json({ error: 'Invalid polygon' });
    }
    const center = coords.reduce(
      (acc, point) => {
        acc.lng += point[0];
        acc.lat += point[1];
        return acc;
      },
      { lat: 0, lng: 0 }
    );
    center.lat /= coords.length;
    center.lng /= coords.length;

    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${center.lat}&lon=${center.lng}&units=metric&appid=${OPENWEATHER_API_KEY}`;
    const weatherData = await fetchJson(url);
    const list = Array.isArray(weatherData.list) ? weatherData.list : [];

    if (list.length === 0) {
      return res.status(500).json({ error: 'OpenWeather forecast data missing' });
    }
    let airSum = 0;
    let airCount = 0;
    let surfaceSum = 0;
    let surfaceCount = 0;

    list.forEach((item) => {
      const temp = item?.main?.temp;
      const feelsLike = item?.main?.feels_like;
      if (typeof temp === 'number') {
        airSum += temp;
        airCount += 1;
      }
      // OpenWeather free forecast has no surface temp; use feels_like as proxy.
      if (typeof feelsLike === 'number') {
        surfaceSum += feelsLike;
        surfaceCount += 1;
      }
    });

    const airTempAvg = airCount ? airSum / airCount : null;
    const surfaceTempAvg = surfaceCount ? surfaceSum / surfaceCount : null;

    res.json({ airTempAvg, surfaceTempAvg });
  } catch (err) {
    console.error('? OpenWeather error:', err);
    res.status(500).json({ error: 'OpenWeather calculation failed' });
  }
});

// ===============================
// 📡 Daily NDVI endpoint (Earth Engine safe)
// ===============================
app.post('/api/ndvi-daily', async (req, res) => {
  try {
    const { coords, dateStart = '2024-06-01', dateEnd = '2024-08-31', cloudPct = 20 } = req.body;

    if (!coords || coords.length < 3) {
      return res.status(400).json({ error: 'Invalid polygon' });
    }

    const geometry = ee.Geometry.Polygon([coords]);
    console.log('Daily NDVI for period:', dateStart, 'to', dateEnd, 'cloudPct:', cloudPct);

    // Фильтруем коллекцию один раз
    const collection = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(geometry)
      .filterDate(dateStart, dateEnd)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', cloudPct));

    const totalCount = await collection.size().getInfo();
    console.log('Total images in period:', totalCount);
    if (totalCount === 0) {
      return res.json({ daily: [], message: 'No images in the period' });
    }

    // Уникальные даты с изображениями
    const uniqueTimes = await collection.aggregate_array('system:time_start').getInfo(); // Получаем JS-массив
    const filteredTimes = uniqueTimes.filter(t => t != null); // JS фильтр null
    const dateList = filteredTimes.map(time => new Date(time).toISOString().split('T')[0]); // YYYY-MM-DD
    console.log('Unique days with data:', dateList.length);

    const dailyStats = [];

    for (const day of dateList) {
      console.log('Processing day:', day);

      const dayCollection = collection.filterDate(ee.Date(day), ee.Date(day).advance(1, 'day'));

      const dayImage = dayCollection
        .median()
        .normalizedDifference(['B8', 'B4'])
        .rename('ndvi')
        .clip(geometry);

      const dayStats = await dayImage.reduceRegion({
        reducer: ee.Reducer.minMax().combine({
          reducer2: ee.Reducer.mean(),
          sharedInputs: true
        }),
        geometry,
        scale: 10,
        maxPixels: 1e9
      }).getInfo();

      if (dayStats.ndvi_mean !== undefined) {
        dailyStats.push({
          date: day,
          ndvi_min: dayStats.ndvi_min,
          ndvi_mean: dayStats.ndvi_mean,
          ndvi_max: dayStats.ndvi_max
        });
      }
    }

    if (dailyStats.length === 0) {
      return res.json({ daily: [], message: 'No daily NDVI data for the period' });
    }

    res.json({ daily: dailyStats });

  } catch (err) {
    console.error('❌ Daily NDVI error:', err);
    res.status(500).json({ error: 'Daily NDVI calculation failed' });
  }
});


// ===============================
// 📡 TIFF NDVI endpoint (для скачивания raster по дню)
// ===============================
app.post('/api/ndvi-tiff', async (req, res) => {
  try {
    const { day, coords, cloudPct = 20 } = req.body;

    if (!day || !coords || coords.length < 3) {
      return res.status(400).json({ error: 'Invalid day or polygon' });
    }

    console.log('TIFF for day:', day, 'coords length:', coords.length, 'cloudPct:', cloudPct);

    const geometry = ee.Geometry.Polygon([coords]);

    // NDVI для дня
    const dayCollection = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterDate(day, ee.Date(day).advance(1, 'day'))
      .filterBounds(geometry)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', cloudPct));

    const dayCount = await dayCollection.size().getInfo();
    console.log('Images for day:', dayCount);
    if (dayCount === 0) {
      return res.json({ error: 'No images for this day' });
    }

    const dayImage = dayCollection
      .median()
      .normalizedDifference(['B8', 'B4'])
      .rename('ndvi')
      .clip(geometry);

    // Проверяем данные
    const hasData = await dayImage.reduceRegion({
      reducer: ee.Reducer.count(),
      geometry,
      scale: 10,
      maxPixels: 1e9
    }).getInfo();

    console.log('Has data count:', hasData.ndvi);
    if (hasData.ndvi === 0) {
      return res.json({ error: 'No NDVI data for this day' });
    }

    // Генерируем TIFF URL
    const tiffUrl = dayImage.getThumbURL({
      format: 'GEO_TIFF',
      dimensions: '1024x1024',  // Размер
      region: geometry,  // Clipped to polygon
      crs: 'EPSG:4326',  // Coord system
      min: -1, max: 1,  // NDVI range
      bands: ['ndvi']  // Только NDVI band
    });

    console.log('TIFF URL generated:', tiffUrl);
    res.json({ tiffUrl });

  } catch (err) {
    console.error('❌ TIFF NDVI error:', err);
    res.status(500).json({ error: 'TIFF generation failed' });
  }
});

app.listen(5000, () => {
  console.log('🚀 Server running on http://localhost:5000');
});
