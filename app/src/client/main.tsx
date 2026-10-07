import { createRoot } from 'react-dom/client';
import '../shared/document.css';
import './styles.css';
import App from './App';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root が見つかりません');
}
createRoot(container).render(<App />);
