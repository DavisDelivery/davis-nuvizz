import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { documentTitle } from './lib/mirror-site.js';

// THE TAB IS WHAT YOU READ WHEN BOTH BOARDS ARE OPEN. index.html ships identically to
// production and to UAT, so the title is set here from the hostname instead — the one
// fact about a deploy nobody can forget to configure (lib/mirror-site.js). Production
// resolves the same string index.html already carried, so nothing changes there.
document.title = documentTitle(window.location.hostname);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
