import './mock-api';
import { createRoot } from 'react-dom/client';
import CrmApp from '../app/crm-app';
import './reset.css';

createRoot(document.getElementById('root')!).render(<CrmApp />);
