import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles.css';

const el = document.getElementById('root');
if (el) {
  const root = createRoot(el);
  root.render(<App />);
}


