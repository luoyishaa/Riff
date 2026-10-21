import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/base.css';
import './styles/layout.css';
import './styles/review.css';
import './styles/editor.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');
createRoot(root).render(<App />);
