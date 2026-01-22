import React from 'react';
import MapComponent from './MapComponent';
import './App.css';

function App() {
  return (
    <div className="App">
      <header className="App-header">
        <h1>NDVI Analyzer</h1>
        <p>Выберите координаты, даты и облачность на левой боковой панели, рисуйте полигон на карте по центру, наблюдайте результаты по NDVI на правой боковой панели.</p>
      </header>
      <div className="main-layout">
        <MapComponent />
      </div>
    </div>
  );
}

export default App;