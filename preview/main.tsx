import './mock-api';
import { createRoot } from 'react-dom/client';
import CrmApp from '../app/crm-app';
import './reset.css';

// Die Vorschau läuft ohne Anmeldung gegen die Mock-API.
createRoot(document.getElementById('root')!).render(<CrmApp userEmail="vorschau@lokal" />);
