// src/screens/QuoteScreen.jsx — embeds the shared Uline rate console as a tab.
// The console is the single source of truth (the @davisdelivery/quote-generator
// package); this app renders it and optionally seeds it from a selected stop.

import React from 'react';
import { UlineQuoteConsole } from '../lib/quote-generator.js';

// Point at a live model JSON to get zero-redeploy fuel/zone/rate updates.
// Leave undefined to use the model bundled in the package.
const MODEL_URL = undefined;

export default function QuoteScreen({ prefill }) {
  return (
    <UlineQuoteConsole
      embedded
      modelUrl={MODEL_URL}
      initialZip={prefill?.zip}
      initialWeight={prefill?.weight}
      initialSkids={prefill?.skids}
      initialLoose={prefill?.loose}
    />
  );
}
