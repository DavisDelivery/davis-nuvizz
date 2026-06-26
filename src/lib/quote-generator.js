import { jsxs as a, jsx as r, Fragment as j } from "react/jsx-runtime";
import { useState as f, useEffect as T, useMemo as o0, useRef as w0 } from "react";
const S0 = {
  30002: 68.67,
  30004: 65.77,
  30005: 65.77,
  30008: 65.77,
  30009: 65.77,
  30011: 65.77,
  30012: 65.77,
  30013: 65.77,
  30014: 68.67,
  30017: 68.67,
  30019: 65.77,
  30021: 68.67,
  30022: 65.77,
  30024: 65.77,
  30025: 65.77,
  30028: 65.77,
  30030: 68.67,
  30032: 68.67,
  30033: 68.67,
  30034: 65.77,
  30035: 65.77,
  30038: 65.77,
  30039: 65.77,
  30040: 65.77,
  30041: 65.77,
  30043: 65.77,
  30044: 65.77,
  30045: 65.77,
  30046: 65.77,
  30047: 65.77,
  30052: 68.67,
  30054: 68.67,
  30058: 65.77,
  30060: 68.67,
  30062: 68.67,
  30063: 68.67,
  30064: 68.67,
  30066: 68.67,
  30067: 68.67,
  30068: 68.67,
  30069: 68.67,
  30071: 65.77,
  30075: 65.77,
  30076: 65.77,
  30078: 65.77,
  30079: 65.77,
  30080: 65.77,
  30082: 65.77,
  30083: 65.77,
  30084: 65.77,
  30087: 65.77,
  30088: 65.77,
  30092: 65.77,
  30093: 65.77,
  30094: 65.77,
  30096: 65.77,
  30097: 65.77,
  30101: 68.67,
  30102: 68.67,
  30103: 71.58,
  30106: 68.67,
  30107: 68.67,
  30114: 68.67,
  30115: 68.67,
  30120: 71.58,
  30121: 71.58,
  30122: 68.67,
  30126: 68.67,
  30127: 68.67,
  30132: 68.67,
  30134: 68.67,
  30135: 68.67,
  30137: 71.58,
  30139: 71.58,
  30141: 68.67,
  30143: 71.58,
  30144: 68.67,
  30148: 68.67,
  30152: 68.67,
  30157: 68.67,
  30168: 68.67,
  30171: 68.67,
  30175: 68.67,
  30177: 68.67,
  30183: 68.67,
  30184: 68.67,
  30188: 68.67,
  30189: 65.77,
  30213: 68.67,
  30214: 68.67,
  30215: 68.67,
  30228: 68.67,
  30236: 68.67,
  30238: 68.67,
  30252: 71.58,
  30253: 71.58,
  30260: 65.77,
  30263: 71.58,
  30265: 71.58,
  30268: 68.67,
  30269: 71.58,
  30273: 68.67,
  30274: 68.67,
  30281: 71.58,
  30288: 68.67,
  30290: 68.67,
  30291: 68.67,
  30294: 68.67,
  30296: 65.77,
  30297: 68.67,
  30303: 68.67,
  30305: 68.67,
  30306: 68.67,
  30307: 68.67,
  30308: 68.67,
  30309: 68.67,
  30310: 68.67,
  30311: 68.67,
  30312: 68.67,
  30313: 68.67,
  30314: 68.67,
  30315: 68.67,
  30316: 68.67,
  30317: 68.67,
  30318: 68.67,
  30319: 68.67,
  30320: 68.67,
  30322: 68.67,
  30324: 68.67,
  30326: 68.67,
  30327: 68.67,
  30328: 68.67,
  30329: 68.67,
  30331: 68.67,
  30332: 68.67,
  30334: 68.67,
  30336: 68.67,
  30337: 68.67,
  30338: 68.67,
  30339: 68.67,
  30340: 68.67,
  30341: 68.67,
  30342: 68.67,
  30344: 68.67,
  30345: 68.67,
  30346: 68.67,
  30349: 68.67,
  30350: 68.67,
  30354: 68.67,
  30360: 68.67,
  30361: 68.67,
  30363: 71.58,
  30501: 65.77,
  30504: 65.77,
  30506: 65.77,
  30507: 65.77,
  30510: 103.01,
  30511: 103.01,
  30517: 65.77,
  30518: 65.77,
  30519: 65.77,
  30521: 68.67,
  30529: 65.77,
  30530: 65.77,
  30531: 103.01,
  30534: 68.67,
  30536: 71.58,
  30540: 71.58,
  30542: 65.77,
  30543: 68.67,
  30547: 71.58,
  30548: 65.77,
  30549: 65.77,
  30553: 71.58,
  30554: 68.67,
  30558: 65.77,
  30566: 65.77,
  30567: 65.77,
  30575: 71.58,
  30601: 68.67,
  30602: 68.67,
  30605: 68.67,
  30606: 68.67,
  30607: 68.67,
  30620: 68.67,
  30621: 71.58,
  30622: 68.67,
  30650: 71.58,
  30655: 68.67,
  30656: 68.67,
  30663: 71.58,
  30666: 68.67,
  30677: 103.01,
  30680: 65.77,
  30701: 71.58,
  30705: 71.58,
  30720: 71.58,
  30721: 71.58,
  30724: 71.58,
  30734: 71.58
}, A0 = {
  300: 65.77,
  301: 68.67,
  302: 71.58,
  303: 68.67,
  305: 65.77,
  306: 68.67,
  307: 71.58
}, U0 = 68.67, y0 = 0.28, z0 = [
  0,
  100,
  200,
  300,
  400,
  460,
  500,
  540,
  580,
  620,
  660,
  700,
  740,
  780,
  840,
  920,
  1e3,
  1080,
  1160,
  1240,
  1320,
  1420,
  1520,
  1650,
  1800,
  2e3,
  2300,
  2800,
  3500,
  5e3,
  8e3,
  99999
], V0 = {
  "65.77": [
    [
      0,
      51.383
    ],
    [
      100,
      51.383
    ],
    [
      200,
      51.383
    ],
    [
      300,
      51.383
    ],
    [
      400,
      51.383
    ],
    [
      460,
      52.067
    ],
    [
      500,
      54.56
    ],
    [
      540,
      58.712
    ],
    [
      580,
      62.832
    ],
    [
      620,
      66.592
    ],
    [
      660,
      71.158
    ],
    [
      700,
      75.217
    ],
    [
      740,
      77.742
    ],
    [
      780,
      77.789
    ],
    [
      840,
      77.789
    ],
    [
      920,
      77.742
    ],
    [
      1e3,
      80.267
    ],
    [
      1080,
      85.837
    ],
    [
      1160,
      93.352
    ],
    [
      1240,
      98.867
    ],
    [
      1320,
      104.754
    ],
    [
      1420,
      115.342
    ],
    [
      1520,
      119.293
    ],
    [
      1650,
      119.293
    ],
    [
      1800,
      119.42
    ],
    [
      2e3,
      123.089
    ],
    [
      2300,
      149.122
    ],
    [
      2800,
      170.635
    ],
    [
      3500,
      228.043
    ]
  ],
  "68.67": [
    [
      0,
      53.65
    ],
    [
      100,
      53.65
    ],
    [
      200,
      53.65
    ],
    [
      300,
      53.65
    ],
    [
      400,
      53.65
    ],
    [
      460,
      53.65
    ],
    [
      500,
      55.128
    ],
    [
      540,
      59.4
    ],
    [
      580,
      62.575
    ],
    [
      620,
      68.073
    ],
    [
      660,
      70.016
    ],
    [
      700,
      73.592
    ],
    [
      740,
      76.333
    ],
    [
      780,
      75.492
    ],
    [
      840,
      74.629
    ],
    [
      920,
      74.682
    ],
    [
      1e3,
      79.711
    ],
    [
      1080,
      88.951
    ],
    [
      1160,
      90.22
    ],
    [
      1240,
      95.583
    ],
    [
      1320,
      105.116
    ],
    [
      1420,
      109.919
    ],
    [
      1520,
      112.528
    ],
    [
      1650,
      112.492
    ],
    [
      1800,
      126.537
    ],
    [
      2e3,
      126.789
    ],
    [
      2300,
      140.728
    ],
    [
      2800,
      172.9
    ],
    [
      3500,
      230.308
    ]
  ],
  "103.01": [
    [
      0,
      80.48
    ],
    [
      100,
      80.483
    ],
    [
      200,
      80.483
    ],
    [
      300,
      80.483
    ],
    [
      400,
      80.48
    ],
    [
      460,
      80.48
    ],
    [
      500,
      80.483
    ],
    [
      540,
      80.483
    ],
    [
      580,
      80.483
    ],
    [
      620,
      80.482
    ],
    [
      660,
      98.47
    ],
    [
      700,
      102.404
    ],
    [
      740,
      81.187
    ],
    [
      780,
      104.728
    ],
    [
      840,
      104.682
    ],
    [
      920,
      80.483
    ],
    [
      1e3,
      107.466
    ],
    [
      1080,
      113.245
    ],
    [
      1160,
      120.105
    ],
    [
      1240,
      94.398
    ],
    [
      1320,
      133.228
    ],
    [
      1420,
      138.569
    ],
    [
      1520,
      146.121
    ],
    [
      1650,
      146.121
    ],
    [
      1800,
      146.694
    ],
    [
      2e3,
      153.344
    ],
    [
      2300,
      170.796
    ],
    [
      2800,
      199.729
    ],
    [
      3500,
      257.136
    ]
  ],
  "71.58": [
    [
      0,
      55.917
    ],
    [
      100,
      55.917
    ],
    [
      200,
      55.917
    ],
    [
      300,
      55.919
    ],
    [
      400,
      55.919
    ],
    [
      460,
      55.919
    ],
    [
      500,
      56.719
    ],
    [
      540,
      60.592
    ],
    [
      580,
      65.167
    ],
    [
      620,
      68.817
    ],
    [
      660,
      74.235
    ],
    [
      700,
      78.195
    ],
    [
      740,
      80.958
    ],
    [
      780,
      82.072
    ],
    [
      840,
      82.488
    ],
    [
      920,
      80.233
    ],
    [
      1e3,
      82.224
    ],
    [
      1080,
      87.846
    ],
    [
      1160,
      95.462
    ],
    [
      1240,
      102.87
    ],
    [
      1320,
      107.483
    ],
    [
      1420,
      128.919
    ],
    [
      1520,
      134.775
    ],
    [
      1650,
      122.122
    ],
    [
      1800,
      135.569
    ],
    [
      2e3,
      135.147
    ],
    [
      2300,
      152.333
    ],
    [
      2800,
      175.174
    ],
    [
      3500,
      232.582
    ]
  ]
}, K0 = [
  [
    0,
    53.65
  ],
  [
    100,
    53.65
  ],
  [
    200,
    53.65
  ],
  [
    300,
    53.65
  ],
  [
    400,
    53.65
  ],
  [
    460,
    53.65
  ],
  [
    500,
    55.341
  ],
  [
    540,
    59.219
  ],
  [
    580,
    63.152
  ],
  [
    620,
    67.21
  ],
  [
    660,
    71.642
  ],
  [
    700,
    75.576
  ],
  [
    740,
    77.792
  ],
  [
    780,
    77.9
  ],
  [
    840,
    77.854
  ],
  [
    920,
    77.792
  ],
  [
    1e3,
    80.638
  ],
  [
    1080,
    86.417
  ],
  [
    1160,
    93.276
  ],
  [
    1240,
    98.837
  ],
  [
    1320,
    106.4
  ],
  [
    1420,
    111.741
  ],
  [
    1520,
    119.293
  ],
  [
    1650,
    119.293
  ],
  [
    1800,
    119.865
  ],
  [
    2e3,
    126.516
  ],
  [
    2300,
    143.967
  ],
  [
    2800,
    172.9
  ],
  [
    3500,
    230.308
  ]
], O0 = [
  1,
  2,
  3,
  4,
  6,
  9,
  99
], P0 = [
  0,
  1,
  2,
  4,
  8,
  16,
  999
], J0 = [
  0,
  500,
  800,
  1200,
  2e3,
  4e3,
  99999
], Z0 = {
  "68.67|0|0|0": 0,
  "65.77|4|0|3": 0.049,
  "68.67|1|0|2": 1.659,
  "68.67|0|0|4": -12.639,
  "65.77|0|0|0": 0,
  "65.77|2|0|2": -0.456,
  "71.58|0|0|0": -5e-3,
  "65.77|0|4|0": 22.442,
  "65.77|1|0|1": -1.74,
  "68.67|1|3|3": 12.793,
  "68.67|1|0|1": -0.187,
  "68.67|0|2|0": 0,
  "68.67|1|0|0": 0,
  "65.77|3|0|2": -0.665,
  "65.77|0|0|1": -2.352,
  "68.67|1|1|2": 7.281,
  "71.58|2|1|2": 8.725,
  "65.77|0|1|0": 0,
  "68.67|3|0|1": 18.066,
  "71.58|0|1|0": -3e-3,
  "65.77|1|0|0": 0,
  "65.77|2|1|5": -110.086,
  "68.67|0|0|1": -1.478,
  "65.77|1|0|2": -0.021,
  "68.67|1|0|3": 0.519,
  "68.67|3|0|3": 1.069,
  "71.58|2|0|3": -3.998,
  "71.58|0|0|1": -1.966,
  "65.77|3|0|4": -8.104,
  "65.77|4|0|4": -8.272,
  "65.77|0|3|0": 2.415,
  "68.67|2|3|2": 21.477,
  "68.67|0|1|0": 0,
  "68.67|2|0|3": 2.08,
  "68.67|3|0|2": 7.005,
  "65.77|1|0|3": -1.699,
  "71.58|0|2|0": -3e-3,
  "65.77|3|0|5": -84.054,
  "103.01|0|0|0": -0,
  "71.58|1|0|3": -3.985,
  "68.67|0|4|0": 25.405,
  "68.67|0|3|0": 0,
  "68.67|4|0|4": -4.739,
  "65.77|2|0|1": 0.503,
  "65.77|5|0|4": -9.914,
  "71.58|1|0|2": -0.855,
  "65.77|0|0|2": -0.616,
  "68.67|2|0|0": 1.28,
  "65.77|0|0|3": -2.242,
  "65.77|3|1|4": -7.673,
  "71.58|1|0|0": -3e-3,
  "65.77|2|2|4": 4.59,
  "71.58|0|3|0": 0,
  "68.67|1|2|0": 14.092,
  "71.58|0|3|1": 43.341,
  "65.77|2|0|0": 2.605,
  "65.77|3|0|1": 24.46,
  "68.67|0|1|3": -1.407,
  "65.77|2|1|1": 12.817,
  "71.58|3|0|3": -4.757,
  "71.58|1|0|1": -1.916,
  "68.67|1|1|1": 6.664,
  "68.67|3|0|4": -4.692,
  "68.67|4|0|0": 30.64,
  "65.77|2|3|2": 29.398,
  "68.67|2|0|2": 2.004,
  "71.58|3|0|1": 22.492,
  "71.58|2|0|2": -1.09,
  "65.77|2|0|4": -7.295,
  "65.77|2|1|0": 14.25,
  "68.67|0|0|3": -0.127,
  "68.67|3|0|0": 13.586,
  "65.77|2|0|3": -1.055,
  "65.77|1|3|1": 38.299,
  "68.67|0|0|2": -0.744,
  "65.77|0|5|1": 74.259,
  "65.77|3|0|3": -0.709,
  "65.77|0|2|0": 0,
  "65.77|0|1|2": -0.947,
  "65.77|0|3|1": 32.897,
  "65.77|5|0|5": -128.182,
  "68.67|2|0|4": -1.993,
  "68.67|3|2|3": 17.481,
  "65.77|0|2|1": 18.063,
  "65.77|1|0|4": -7.933,
  "68.67|3|3|2": 55.223,
  "68.67|0|1|1": 2.42,
  "68.67|1|1|0": 0,
  "71.58|1|1|0": -3e-3,
  "71.58|3|0|5": -124.194,
  "65.77|1|1|0": 0,
  "68.67|1|0|4": -9.616,
  "71.58|0|0|2": -1.292,
  "68.67|0|1|2": 1.896,
  "68.67|2|1|2": 8.375,
  "68.67|2|2|3": 18.534,
  "65.77|3|0|0": 16.309,
  "65.77|2|1|3": 1.763,
  "65.77|5|2|4": -2.441,
  "65.77|1|1|2": 5.39,
  "65.77|3|1|3": 0.441,
  "65.77|0|1|1": 4.752,
  "68.67|0|2|1": 14.401,
  "68.67|4|1|3": 13.934,
  "68.67|1|2|1": 17.189,
  "65.77|4|0|0": 0,
  "68.67|4|0|2": 31.481,
  "71.58|0|0|3": -3.299,
  "65.77|3|2|2": 11.891,
  "65.77|1|1|1": 6.83,
  "71.58|5|0|4": -6.366,
  "65.77|2|3|1": 56.571,
  "68.67|1|5|2": 39.322,
  "68.67|2|0|1": 3.173,
  "71.58|1|0|4": -8.988,
  "68.67|3|0|5": -90.987,
  "68.67|1|4|2": 33.017,
  "65.77|2|2|2": 16.777,
  "68.67|1|2|4": 12.033,
  "65.77|1|3|3": 27.977,
  "68.67|4|0|5": -106.361,
  "71.58|4|1|3": -10.591,
  "71.58|4|0|4": -7.655,
  "68.67|1|2|3": 14.903,
  "71.58|1|1|1": -1.448,
  "68.67|5|0|5": -123.296,
  "65.77|4|2|4": 4.033,
  "65.77|0|0|4": -8.605,
  "71.58|2|0|1": 10.765,
  "68.67|0|2|2": 12.349,
  "65.77|1|4|1": 48.851,
  "71.58|0|0|4": -9.136,
  "103.01|1|0|1": -6e-3,
  "71.58|2|0|4": -10.334,
  "68.67|2|4|1": 24.896,
  "68.67|2|5|3": 35.921,
  "68.67|3|1|3": 2.206,
  "68.67|3|1|2": 6.201,
  "71.58|0|2|1": 21.066,
  "68.67|1|3|1": 25.771,
  "65.77|1|3|0": 24.039,
  "71.58|3|0|0": 19.103,
  "65.77|1|1|3": 0.09,
  "65.77|0|4|1": 58.452,
  "65.77|2|3|3": 31.616,
  "65.77|4|5|4": 92.593,
  "65.77|1|5|1": 74.532,
  "103.01|0|0|1": -0.675,
  "68.67|1|2|2": 14.921,
  "68.67|1|3|0": 24.459,
  "103.01|0|3|0": 0,
  "68.67|0|4|1": 35.041,
  "68.67|5|2|4": 14.687,
  "103.01|1|0|0": 0,
  "65.77|2|1|2": 4.583,
  "68.67|2|1|3": 6.309,
  "68.67|5|1|4": -9.422,
  "65.77|1|2|2": 17.744,
  "65.77|1|2|1": 18.199,
  "68.67|5|0|4": -6.258,
  "65.77|0|2|2": 14.792,
  "68.67|2|2|2": 15.668,
  "65.77|2|2|3": 17.016,
  "65.77|3|1|2": 0.506,
  "65.77|1|4|0": 36.372,
  "71.58|0|4|1": 45.259,
  "68.67|4|2|4": 16.775,
  "68.67|4|2|3": 23.618,
  "71.58|3|5|1": 92.607,
  "65.77|1|2|0": 16.631,
  "71.58|1|1|4": -27.057,
  "71.58|2|1|1": 24.948,
  "65.77|0|3|2": 14.852,
  "65.77|3|2|3": 16.23,
  "65.77|0|1|3": -2.642,
  "65.77|1|2|3": 9.434,
  "68.67|4|1|4": -4.62,
  "68.67|3|2|4": -5.142,
  "68.67|0|1|4": -12.87,
  "71.58|5|0|5": -116.375,
  "68.67|1|1|3": 5.36,
  "65.77|3|4|3": 46.118,
  "65.77|3|2|4": 2.926,
  "65.77|4|0|5": -78.366,
  "65.77|1|2|4": -4.389,
  "71.58|4|0|5": -107.023,
  "65.77|1|5|2": 66.875,
  "68.67|4|0|3": 8.711,
  "71.58|4|0|3": -1.08,
  "71.58|5|0|3": 38.202,
  "103.01|0|2|0": -3e-3,
  "71.58|1|2|3": 12.464,
  "71.58|3|5|3": 181.305,
  "65.77|0|4|2": 42.734,
  "68.67|3|3|3": 57.934,
  "71.58|0|1|1": -0.642,
  "103.01|1|0|2": -23.812,
  "71.58|2|0|0": 5.631,
  "65.77|0|5|0": 74.617,
  "65.77|4|1|4": -8.978,
  "68.67|2|1|1": 7.348,
  "71.58|3|0|2": 0.856,
  "68.67|3|4|3": 66.451,
  "71.58|3|0|4": -7.89,
  "68.67|3|1|4": -0.724,
  "65.77|2|0|5": -84.621,
  "71.58|0|1|2": -1.954,
  "68.67|1|4|0": 26.9,
  "65.77|4|0|1": 40.572,
  "65.77|5|0|2": 51.3,
  "65.77|5|0|3": 65.424,
  "68.67|2|0|5": -102.628,
  "65.77|5|1|4": -6.319,
  "103.01|0|1|0": 0,
  "65.77|3|3|3": 34.592,
  "68.67|3|5|4": 120.805,
  "71.58|2|1|0": -4e-3,
  "71.58|1|3|0": 20.964,
  "68.67|3|2|2": 39.227,
  "65.77|3|4|4": 48.384,
  "68.67|5|3|5": -62.237,
  "68.67|5|5|5": 37.457,
  "65.77|2|3|4": 45.826,
  "71.58|0|1|4": -12.437,
  "68.67|5|0|3": 53.048,
  "68.67|1|1|4": -11.924,
  "68.67|2|2|0": 29.242,
  "65.77|2|5|2": 53.738,
  "65.77|4|1|3": 0.925,
  "65.77|2|1|4": -6.668,
  "71.58|0|4|0": 19.228,
  "68.67|2|3|1": 25.167,
  "65.77|5|4|5": -107.592,
  "68.67|0|3|1": 25.275,
  "71.58|1|2|2": 10.852,
  "71.58|1|1|2": 5.997,
  "65.77|4|4|4": 70.611,
  "71.58|1|2|0": 6.228,
  "65.77|2|5|3": 52.561,
  "103.01|4|0|4": -30.93,
  "68.67|3|4|2": 38.729,
  "68.67|1|5|1": 37.042,
  "68.67|5|0|2": 46.018,
  "65.77|3|1|5": -74.152,
  "65.77|0|4|3": 15.702,
  "68.67|2|4|2": 28.618,
  "65.77|3|5|3": 91.162,
  "68.67|2|4|3": 35.063,
  "103.01|3|0|4": -41.065,
  "68.67|0|5|1": 106.514,
  "103.01|2|0|3": -33.729,
  "71.58|0|5|2": 74.742,
  "68.67|3|1|1": 40.339,
  "71.58|0|1|3": -3.672,
  "65.77|1|3|2": 34.583,
  "65.77|1|0|5": -114.643,
  "65.77|4|0|2": 41.442,
  "71.58|2|2|2": 19.356,
  "68.67|4|4|4": 86.123,
  "65.77|4|3|4": 19.396,
  "68.67|1|4|1": 30.045,
  "68.67|2|3|4": 41.757,
  "71.58|1|5|2": 95.445,
  "68.67|2|1|0": 5.67,
  "68.67|1|3|2": 24.304,
  "68.67|0|5|0": 32.428,
  "65.77|3|4|2": 112.141,
  "65.77|3|5|4": 27.289,
  "71.58|0|5|1": 186.958,
  "68.67|1|0|5": -130.545,
  "65.77|5|1|3": 15.29,
  "68.67|2|3|3": 23.223,
  "68.67|3|1|0": 23.759,
  "65.77|1|4|2": 37.277,
  "68.67|3|2|1": 15.329,
  "103.01|0|0|4": -43.428,
  "65.77|2|4|2": 40.499,
  "68.67|3|5|3": 118.112,
  "68.67|5|0|1": 187.108,
  "68.67|4|0|1": 39.861,
  "65.77|5|2|5": -86.637,
  "65.77|4|3|3": 25.091,
  "65.77|5|1|5": -102.93,
  "71.58|4|0|2": 50.638,
  "65.77|3|3|4": 12.139,
  "65.77|1|1|5": -114.64,
  "65.77|1|1|4": -7.577,
  "103.01|3|0|3": -26.661,
  "68.67|5|3|4": 9.66,
  "71.58|1|1|3": -5.482,
  "71.58|1|3|3": 11.715,
  "68.67|2|1|5": -52.888,
  "65.77|4|5|3": 97.56,
  "68.67|4|3|4": 32.259,
  "103.01|0|0|2": -18.758,
  "65.77|2|4|3": 37.792,
  "68.67|5|2|5": -155.755,
  "65.77|2|4|1": 47.888,
  "68.67|2|2|1": 29.668,
  "68.67|2|1|4": -4.479,
  "71.58|1|0|5": -100.91,
  "103.01|2|0|4": -42.473,
  "71.58|0|4|2": 26.691,
  "68.67|1|1|5": -103.19,
  "65.77|3|3|2": 35.488,
  "71.58|2|4|3": 59.654,
  "71.58|1|3|1": 25.841,
  "71.58|3|1|3": 0.474,
  "68.67|0|5|2": 204.334,
  "65.77|5|3|5": -214.359,
  "68.67|0|4|2": 57.886,
  "68.67|4|5|3": 73.342,
  "68.67|0|2|3": 25.378,
  "71.58|2|4|2": 37.931,
  "68.67|0|3|2": 25.848,
  "71.58|1|2|1": 19.021,
  "68.67|1|4|3": 25.131,
  "65.77|2|2|1": 19.679,
  "71.58|4|5|4": 164.498,
  "71.58|0|5|0": 92.311,
  "71.58|1|4|2": 60.413,
  "71.58|3|4|3": 52.134,
  "103.01|2|0|2": -18.975,
  "65.77|0|1|4": -3.936,
  "71.58|2|1|4": -9.934,
  "103.01|3|0|2": -32.476,
  "68.67|2|5|4": 142.574,
  "65.77|0|2|3": 8.607,
  "71.58|1|3|2": 32.924,
  "68.67|0|4|3": 15.91,
  "103.01|2|0|0": -1e-3,
  "68.67|5|1|3": 0.829,
  "71.58|4|1|4": -12.161,
  "65.77|2|4|4": 65.607,
  "71.58|1|4|3": 33.419,
  "71.58|2|1|3": -3.923,
  "71.58|3|1|1": 36.114,
  "71.58|3|1|2": 19.186,
  "65.77|2|2|0": 35.998,
  "65.77|3|1|1": 10.13,
  "103.01|2|0|1": -0.902,
  "103.01|5|0|4": 45.029,
  "103.01|1|0|3": -28.812,
  "71.58|2|3|2": 39.376,
  "71.58|4|0|1": 35.898,
  "65.77|3|1|0": 31.333,
  "68.67|5|1|5": -50.246,
  "71.58|2|5|0": 106.346,
  "65.77|1|4|4": 66.484,
  "65.77|0|5|2": 127.428,
  "65.77|4|1|2": 46.57,
  "71.58|4|0|0": 34.048,
  "68.67|4|3|3": 45.061,
  "65.77|1|4|3": 81.381,
  "65.77|4|1|1": 42.981,
  "71.58|3|3|2": 29.097,
  "71.58|0|2|2": 7.194,
  "65.77|5|4|4": 34.485,
  "68.67|2|5|2": 85.159,
  "71.58|4|1|5": -105.547,
  "71.58|5|5|5": 88.53,
  "103.01|5|0|5": -101.68,
  "68.67|5|4|4": 45.659,
  "71.58|1|4|1": 23.114,
  "103.01|5|0|3": 36.078,
  "68.67|3|1|5": -142.089,
  "71.58|1|5|3": 76.157,
  "71.58|2|0|5": -97.433,
  "71.58|2|5|1": 95.866,
  "68.67|4|2|5": -70.91,
  "71.58|3|1|4": -3.51,
  "65.77|0|3|3": 4.966,
  "103.01|0|0|3": -26.21,
  "68.67|4|1|5": -50.944,
  "103.01|4|0|1": 28.718,
  "65.77|2|3|0": 47.245,
  "68.67|0|3|3": 32.875,
  "68.67|2|2|4": 13.113,
  "68.67|1|4|4": 45.222,
  "65.77|2|5|4": 81.591
}, Q0 = {
  "0|0|0": 0,
  "4|0|3": 1.065,
  "1|0|2": 0.012,
  "0|0|4": -11.348,
  "2|0|2": -0.106,
  "0|4|0": 23.706,
  "1|0|1": -1.496,
  "1|3|3": 17.661,
  "0|2|0": 0,
  "1|0|0": 0,
  "3|0|2": 1.216,
  "0|0|1": -2.091,
  "1|1|2": 6.075,
  "2|1|2": 7.245,
  "0|1|0": 0,
  "3|0|1": 21.144,
  "2|1|5": -105.197,
  "1|0|3": -1.311,
  "3|0|3": -0.101,
  "2|0|3": -0.074,
  "3|0|4": -7.743,
  "4|0|4": -7.925,
  "0|3|0": 0,
  "2|3|2": 27.171,
  "3|0|5": -89.352,
  "2|0|1": 1.913,
  "5|0|4": -8.936,
  "0|0|2": -0.872,
  "2|0|0": 2.45,
  "0|0|3": -2.145,
  "3|1|4": -4.099,
  "2|2|4": 5.32,
  "1|2|0": 14.855,
  "0|3|1": 31.281,
  "0|1|3": -2.694,
  "2|1|1": 12.159,
  "1|1|1": 6.621,
  "4|0|0": 17.819,
  "2|0|4": -7.563,
  "2|1|0": 5.67,
  "3|0|0": 15.933,
  "1|3|1": 28.868,
  "0|5|1": 101.075,
  "0|1|2": -0.145,
  "5|0|5": -123.296,
  "3|2|3": 16.23,
  "0|2|1": 17.087,
  "1|0|4": -8.69,
  "3|3|2": 54.521,
  "0|1|1": 3.028,
  "1|1|0": 0,
  "2|2|3": 17.016,
  "2|1|3": 2.19,
  "5|2|4": 12.731,
  "3|1|3": 0.723,
  "4|1|3": 3.187,
  "1|2|1": 17.853,
  "4|0|2": 33.053,
  "3|2|2": 25.871,
  "2|3|1": 29.474,
  "1|5|2": 66.875,
  "1|4|2": 38.04,
  "2|2|2": 16.325,
  "1|2|4": 11.014,
  "4|0|5": -102.401,
  "1|2|3": 11.921,
  "4|2|4": 7.911,
  "0|2|2": 13.325,
  "1|4|1": 34.27,
  "2|4|1": 34.451,
  "2|5|3": 52.393,
  "3|1|2": 4.912,
  "1|3|0": 23.825,
  "1|1|3": 0.564,
  "0|4|1": 53.478,
  "2|3|3": 30.212,
  "4|5|4": 97.108,
  "1|5|1": 59.402,
  "1|2|2": 15.793,
  "5|1|4": -5.597,
  "1|4|0": 35.466,
  "4|2|3": 14.832,
  "3|5|1": 92.607,
  "1|1|4": -10.818,
  "0|3|2": 19.969,
  "4|1|4": -5.523,
  "3|2|4": -1.606,
  "3|4|4": 39.432,
  "0|1|4": -12.459,
  "3|4|3": 53.34,
  "5|0|3": 49.731,
  "3|5|3": 94.103,
  "0|4|2": 49.811,
  "3|3|3": 40.582,
  "0|5|0": 70.111,
  "2|5|1": 95.866,
  "2|0|5": -96.343,
  "4|0|1": 36.929,
  "5|0|2": 47.12,
  "3|5|4": 41.91,
  "5|3|5": -83.575,
  "0|3|3": 14.247,
  "5|5|5": 50.855,
  "2|3|4": 43.791,
  "2|2|0": 35.59,
  "2|5|2": 64.119,
  "2|1|4": -5.661,
  "5|4|5": -106.513,
  "4|4|4": 71.079,
  "5|0|1": 65.091,
  "3|4|2": 57.547,
  "3|1|5": -94.028,
  "0|4|3": 17.554,
  "1|5|3": 61.56,
  "2|4|2": 35.56,
  "2|4|3": 37.453,
  "4|1|5": -106.628,
  "0|5|2": 78.261,
  "3|1|1": 31.348,
  "1|3|2": 31.767,
  "1|0|5": -114.643,
  "4|1|1": 42.55,
  "4|3|4": 26.723,
  "1|1|5": -102.899,
  "5|1|3": 7.409,
  "3|1|0": 25.308,
  "3|2|1": 18.241,
  "5|2|5": -97.959,
  "4|3|3": 39.52,
  "5|1|5": -90.119,
  "3|3|4": 20.303,
  "5|3|4": 11.825,
  "4|5|3": 93.653,
  "2|2|1": 25.898,
  "0|2|3": 18.703,
  "1|4|3": 64.358,
  "3|5|2": 100.047,
  "2|5|4": 107.666,
  "1|5|0": 85.134,
  "2|3|0": 41.203,
  "2|4|4": 62.9,
  "4|2|5": -70.91,
  "2|5|0": 106.346,
  "1|4|4": 45.224,
  "3|2|0": 13.337,
  "5|5|4": 49.308,
  "4|1|2": 31.126,
  "5|4|4": 36.896
}, W0 = {
  "0|0": 0,
  "4|0": -2.812,
  "1|0": 0,
  "2|0": 0,
  "0|4": 27.163,
  "1|3": 27.809,
  "0|2": 0,
  "3|0": -0.084,
  "1|1": 2.606,
  "2|1": 4.655,
  "0|1": 0,
  "0|3": 3.317,
  "2|3": 30.093,
  "5|0": -26.541,
  "3|1": 1.519,
  "2|2": 17.222,
  "1|2": 16.025,
  "0|5": 72.542,
  "3|2": 13.238,
  "3|3": 50.791,
  "5|2": -2.441,
  "4|1": -0.505,
  "1|5": 66.392,
  "1|4": 36.161,
  "4|2": 8.678,
  "2|4": 35.798,
  "2|5": 68.575,
  "4|5": 96.323,
  "5|1": -9.887,
  "3|5": 93.332,
  "3|4": 51.384,
  "5|4": -27.436,
  "5|3": -8.112,
  "5|5": 49.308,
  "4|4": 68.791,
  "4|3": 27.82
}, C0 = {
  Z1: {
    "< 500": 65.77,
    "500 - 999": 83.79,
    "1,000 - 2,499": 123.73,
    "2,500 - 4,999": 190.88,
    "5,000 - 9,999": 659.31,
    "10,000 +": 1184.18
  },
  Z2: {
    "< 500": 68.67,
    "500 - 999": 84.63,
    "1,000 - 2,499": 121.42,
    "2,500 - 4,999": 180.29,
    "5,000 - 9,999": 662.21,
    "10,000 +": 1187.08
  },
  Z3: {
    "< 500": 71.57,
    "500 - 999": 87.19,
    "1,000 - 2,499": 125.11,
    "2,500 - 4,999": 194.99,
    "5,000 - 9,999": 665.12,
    "10,000 +": 1189.99
  },
  Z4: {
    "< 500": 103.01,
    "500 - 999": 103.02,
    "1,000 - 2,499": 120.51,
    "2,500 - 4,999": 189.35,
    "5,000 - 9,999": 696.54,
    "10,000 +": 1221.4
  }
}, j0 = [
  "< 500",
  "500 - 999",
  "1,000 - 2,499",
  "2,500 - 4,999",
  "5,000 - 9,999",
  "10,000 +"
], T0 = {
  Z1: [
    "5,000 - 9,999",
    "10,000 +"
  ],
  Z2: [
    "5,000 - 9,999",
    "10,000 +"
  ],
  Z3: [
    "5,000 - 9,999",
    "10,000 +"
  ],
  Z4: [
    "2,500 - 4,999",
    "5,000 - 9,999",
    "10,000 +"
  ]
}, H0 = {
  Z1: 65.77,
  Z2: 68.67,
  Z3: 71.58,
  Z4: 103.01
}, D0 = {
  50: 0.63,
  55: 0.69,
  60: 0.74,
  65: 0.8,
  70: 0.86,
  85: 1,
  100: 1.14,
  110: 1.22,
  125: 1.35,
  150: 1.51,
  175: 1.71,
  200: 1.94,
  250: 2.29,
  300: 2.69,
  "77.5": 0.94,
  "92.5": 1.06
}, F0 = 85, R0 = {
  70: 6.2,
  85: 30.2,
  100: 5.3,
  110: 2,
  125: 1.4,
  150: 1.3,
  175: 0.8,
  "77.5": 39,
  "92.5": 13.2
}, s0 = {
  zone5: S0,
  zone3: A0,
  global_: U0,
  fuel_embedded: y0,
  KN: z0,
  curves: V0,
  pk: K0,
  SKB: O0,
  LOB: P0,
  WBc: J0,
  resM: Z0,
  resG: Q0,
  resW: W0,
  rateSheet: C0,
  breaks: j0,
  estCells: T0,
  zoneMin: H0,
  classMult: D0,
  classDefault: F0,
  classMix: R0
}, M0 = "v0.9.1", E0 = "data:image/jpeg;base64,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", I0 = (e, t) => {
  let n = 0, c = e.length;
  for (; n < c; ) {
    const i = n + c >> 1;
    e[i] <= t ? n = i + 1 : c = i;
  }
  return n;
}, H = (e, t) => I0(e, t) - 1;
function L0(e, t) {
  if (t <= e[0][0]) return e[0][1];
  const n = e.length;
  if (t >= e[n - 1][0]) {
    const [c, i] = e[n - 2], [l, d] = e[n - 1];
    return l === c ? d : i + (d - i) * (t - c) / (l - c);
  }
  for (let c = 1; c < n; c++)
    if (t <= e[c][0]) {
      const [i, l] = e[c - 1], [d, h] = e[c];
      return d > i ? l + (h - l) * (t - i) / (d - i) : l;
    }
  return e[n - 1][1];
}
const Q = { 65.77: "Z1", 68.67: "Z2", 71.58: "Z3", 103.01: "Z4" }, B0 = (e) => Q[Math.round(e * 100) / 100] || "Z?", S = (e) => e.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), X0 = (e, t) => (t = String(t), e.zone5[t] ?? e.zone3[t.slice(0, 3)] ?? e.global_), G0 = (e, t, n) => Math.max(L0(e.curves[String(Math.round(t * 100) / 100)] || e.pk, n), t / 1.28);
function Y0(e, t, n, c, i) {
  const l = Math.round(t * 100) / 100, d = H(e.SKB, Math.max(n, 1)), h = H(e.LOB, c), u = H(e.WBc, i), k = `${l}|${d}|${h}|${u}`;
  if (k in e.resM) return e.resM[k];
  const p = `${d}|${h}|${u}`;
  if (p in e.resG) return e.resG[p];
  const g = `${d}|${h}`;
  return g in e.resW ? e.resW[g] : 0;
}
function d0(e, t, n, c, i) {
  const l = X0(e, t);
  return { zb: l, lh: G0(e, l, n) + Y0(e, l, c, i, n) };
}
function $0(e) {
  const t = { Z1: { min: 65.77, zips: [], pfx: [] }, Z2: { min: 68.67, zips: [], pfx: [] }, Z3: { min: 71.58, zips: [], pfx: [] }, Z4: { min: 103.01, zips: [], pfx: [] } };
  for (const [n, c] of Object.entries(e.zone5)) {
    const i = Q[Math.round(c * 100) / 100];
    t[i] && t[i].zips.push(n);
  }
  for (const [n, c] of Object.entries(e.zone3)) {
    const i = Q[Math.round(c * 100) / 100];
    t[i] && t[i].pfx.push(n);
  }
  for (const n in t)
    t[n].zips.sort(), t[n].pfx.sort();
  return t;
}
function pe(e, { zip: t, weight: n, skids: c = 1, loose: i = 0, fuelPct: l = 28, marginPct: d = 0 }) {
  const h = Number(n) || 0, u = (Number(l) || 0) / 100, k = (Number(d) || 0) / 100, p = d0(e, t, h, c, i), g = p.lh * (1 + u);
  return { zone: Q[Math.round(p.zb * 100) / 100] || "Z?", zb: p.zb, linehaul: p.lh, fuelAmt: p.lh * u, allIn: g, quoted: g * (1 + k) };
}
const he = s0;
let q = s0;
const _0 = (e, t, n, c) => d0(q, e, t, n, c);
function ee(e, t, n, c) {
  return e ? t > 6 || n > 2500 || c > 4 ? { key: "est", label: "estimate", note: "Heavy or high-piece freight prices with wider variance — treat this as a starting figure." } : c > 0 ? { key: "std", label: "has loose freight", note: "Loose pieces run looser than pallet freight — within $5 on ~69% vs ~94% pallet-only." } : t <= 4 && n <= 1500 ? { key: "core", label: "high confidence", note: "Pallet freight in the core range — matches Uline within $5 on ~94% of shipments." } : { key: "std", label: "standard", note: "Weight-and-zone estimate — Uline's basis for this lane." } : { key: "est", label: "estimate", note: "This ZIP isn't in the recent Uline data — rate is estimated from the surrounding area zone." };
}
const c0 = { orange: "#f96332", blue: "#2ca8ff", green: "#18ce0f", purple: "#9368e9", red: "#ff3636" }, re = { orange: "#e8521f", blue: "#1f93e6", green: "#15b30d", purple: "#7e52d8", red: "#e62a2a" }, te = { orange: "#f9633233", blue: "#2ca8ff33", green: "#18ce0f33", purple: "#9368e933", red: "#ff363633" }, ae = `
@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap');

.rc-root{ --s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:20px;--s6:24px;--s8:32px;
  --rc:12px;--ri:10px;--pill:30px; --t:200ms cubic-bezier(.2,.7,.3,1);
  --bg:#f5f6fa; --card:#ffffff;
  --ink:#2c2c2c; --muted:#8a8a8a; --faint:#b3b3b3; --line:#ededed; --line-2:#e3e3e3;
  --ok:#18ce0f; --warn:#ffb236;
  --hero1:#1f2148; --hero2:#2c2f63;
  font-family:'Montserrat',-apple-system,BlinkMacSystemFont,sans-serif;
  min-height:100vh; background:var(--bg); color:var(--ink); -webkit-font-smoothing:antialiased; }
.rc-root *{ box-sizing:border-box; }
.rc-root button{ font:inherit;cursor:pointer;border:none;background:none;color:inherit; }
.rc-root input,.rc-root select{ font:inherit; }
@media (prefers-reduced-motion: reduce){ .rc-root *{ transition:none !important; animation:none !important; } }
.rc-root.rc-embedded{ min-height:0; background:transparent; }
.rc-root.rc-embedded .rc-wrap{ padding-top:var(--s4); padding-bottom:var(--s5); }

.rc-wrap{ max-width:468px;margin:0 auto;padding:var(--s6) var(--s4) var(--s8); }

/* header */
.rc-head{ display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--s5); }
.rc-brand{ display:flex;align-items:center;gap:var(--s3); }
.rc-logo{ width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--accent-d));display:grid;place-items:center;color:#fff;font-weight:700;font-size:16px;box-shadow:0 4px 12px -2px var(--accent-ring); }
.rc-logoimg{ height:32px;width:auto;display:block; }
.rc-bk{ font-size:14px;font-weight:700;line-height:1.1;color:var(--ink); }
.rc-bs{ font-size:11px;color:var(--muted);font-weight:500; }
.rc-right{ display:flex;align-items:center;gap:var(--s3); }
.rc-ver{ font-size:11px;font-weight:600;color:var(--muted);padding:3px 9px;border-radius:var(--pill);background:var(--card);box-shadow:0 1px 6px rgba(0,0,0,.05); }

/* accent picker */
.rc-accents{ display:inline-flex;gap:6px;padding:5px 7px;background:var(--card);border-radius:var(--pill);box-shadow:0 1px 6px rgba(0,0,0,.05); }
.rc-acc{ width:16px;height:16px;border-radius:50%;transition:transform var(--t),box-shadow var(--t);box-shadow:0 0 0 0 rgba(0,0,0,0); }
.rc-acc:hover{ transform:scale(1.15); }
.rc-acc.on{ box-shadow:0 0 0 2px var(--card),0 0 0 4px currentColor;transform:scale(1.05); }
.rc-acc:focus-visible{ outline:none;box-shadow:0 0 0 2px var(--card),0 0 0 4px var(--ink); }

/* tabs */
.rc-tabs{ display:flex;gap:var(--s1);background:#eceef3;border-radius:var(--pill);padding:5px;margin-bottom:var(--s5); }
.rc-tab{ flex:1;text-align:center;font-size:12.5px;font-weight:600;color:var(--muted);padding:9px 0;border-radius:var(--pill);transition:color var(--t),background var(--t),box-shadow var(--t); }
.rc-tab:hover{ color:var(--ink); }
.rc-tab.on{ background:var(--card);color:var(--ink);box-shadow:0 3px 10px -2px rgba(0,0,0,.12); }
.rc-tab:focus-visible{ outline:none;box-shadow:0 0 0 2px var(--accent-ring); }

/* cards */
.rc-card{ background:var(--card);border-radius:var(--rc);box-shadow:0 1px 20px 0 rgba(0,0,0,.06);overflow:hidden;margin-bottom:var(--s4); }
.rc-chead{ padding:var(--s5) var(--s5) 0; }
.rc-ccat{ font-size:10.5px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.07em; }
.rc-ctitle{ margin:3px 0 0;font-size:17px;font-weight:600;color:var(--ink); }
.rc-csub{ margin:4px 0 0;font-size:12px;color:var(--muted);line-height:1.5; }

/* hero (dark gradient) */
.rc-hero{ position:relative;background:linear-gradient(135deg,var(--hero1),var(--hero2));border-radius:var(--rc);overflow:hidden;padding:var(--s6) var(--s5) 0;margin-bottom:var(--s4);box-shadow:0 8px 30px -10px rgba(31,33,72,.55); }
.rc-cat{ font-size:10.5px;font-weight:600;color:rgba(255,255,255,.55);text-transform:uppercase;letter-spacing:.08em; }
.rc-price{ display:flex;align-items:baseline;gap:6px;margin-top:8px; }
.rc-cur{ font-size:24px;font-weight:600;color:rgba(255,255,255,.6); }
.rc-amt{ font-size:50px;font-weight:600;letter-spacing:-.02em;line-height:1;color:#fff;font-variant-numeric:tabular-nums; }
.rc-sub{ margin-top:9px;font-size:12.5px;color:rgba(255,255,255,.72);font-weight:500; }
@keyframes rc-pop{ 0%{opacity:.4;transform:translateY(3px);} 100%{opacity:1;transform:none;} }
.rc-anim{ animation:rc-pop var(--t); }
.rc-hstatus{ display:flex;flex-wrap:wrap;gap:var(--s2);margin-top:var(--s4); }
.rc-hpill{ display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:4px 10px;border-radius:var(--pill);background:rgba(255,255,255,.10);color:#fff; }
.rc-hdot{ width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.6); }
.rc-hpill.ok .rc-hdot{ background:var(--ok); } .rc-hpill.warn .rc-hdot{ background:var(--warn); }
.rc-sparkwrap{ margin:16px -20px 0; }
.rc-spark{ display:block;width:100%;height:auto; }

/* ledger */
.rc-ledger{ padding:var(--s4) var(--s5); }
.rc-lrow{ display:flex;justify-content:space-between;align-items:center;padding:7px 0; }
.rc-lk{ font-size:12.5px;color:var(--muted);font-weight:500; }
.rc-lv{ font-size:13px;color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums; }
.rc-lv.disc{ color:var(--ok); }
.rc-lrow.tot{ margin-top:4px;padding-top:13px;border-top:1px solid var(--line); }
.rc-lrow.tot .rc-lk{ font-weight:700;color:var(--ink);font-size:13px; }
.rc-lrow.tot .rc-lv{ font-size:16px;font-weight:700; }

/* form */
.rc-divhd{ padding:var(--s2) var(--s5) 0;font-size:10.5px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.07em;border-top:1px solid var(--line);margin-top:var(--s2);padding-top:var(--s4); }
.rc-form{ padding:var(--s4) var(--s5) var(--s5);display:grid;grid-template-columns:1fr 1fr;gap:var(--s4); }
.rc-field{ display:flex;flex-direction:column;gap:7px;min-width:0; }
.rc-field.col{ grid-column:1 / -1; }
.rc-grid2{ display:grid;grid-template-columns:1fr 1fr;gap:var(--s4); }
.rc-label{ font-size:12px;font-weight:600;color:var(--ink);display:flex;flex-direction:column;gap:2px; }
.rc-hint{ font-size:11px;font-weight:500;color:var(--faint);line-height:1.35; }

/* inputs */
.rc-input{ width:100%;font-size:14.5px;font-weight:500;color:var(--ink);background:#fff;border:1px solid var(--line-2);border-radius:var(--ri);padding:10px 13px;transition:border-color var(--t),box-shadow var(--t);font-variant-numeric:tabular-nums; }
.rc-input::placeholder{ color:var(--faint); }
.rc-input:hover{ border-color:#cfcfcf; }
.rc-input:focus{ outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-ring); }
.rc-sfx{ display:flex;align-items:center;gap:6px;background:#fff;border:1px solid var(--line-2);border-radius:var(--ri);padding:0 13px;transition:border-color var(--t),box-shadow var(--t); }
.rc-sfx:focus-within{ border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-ring); }
.rc-sfx input{ flex:1;min-width:0;border:none;background:transparent;font-size:14.5px;font-weight:500;color:var(--ink);padding:10px 0;outline:none;font-variant-numeric:tabular-nums; }
.rc-unit{ font-size:12px;color:var(--faint);font-weight:600; }
.rc-narrow{ max-width:170px; }
.rc-select{ appearance:none;-webkit-appearance:none;width:100%;font-size:14px;font-weight:500;color:var(--ink);background-color:#fff;border:1px solid var(--line-2);border-radius:var(--ri);padding:10px 36px 10px 13px;transition:border-color var(--t),box-shadow var(--t);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 13px center; }
.rc-select:hover{ border-color:#cfcfcf; }
.rc-select:focus{ outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-ring); }

/* stepper */
.rc-step{ display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid var(--line-2);border-radius:var(--ri);padding:4px; }
.rc-step button{ width:38px;height:34px;border-radius:8px;font-size:18px;color:var(--muted);display:grid;place-items:center;transition:background var(--t),color var(--t),transform var(--t); }
.rc-step button:hover:not(:disabled){ background:var(--bg);color:var(--ink); }
.rc-step button:active:not(:disabled){ transform:scale(.9); }
.rc-step button:disabled{ opacity:.3;cursor:not-allowed; }
.rc-step button:focus-visible{ outline:none;box-shadow:0 0 0 2px var(--accent-ring); }
.rc-count{ font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--ink); }

/* presets */
.rc-fuelrow{ display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap; }
.rc-presets{ display:inline-flex;gap:4px;background:#eceef3;border-radius:var(--pill);padding:4px; }
.rc-preset{ font-size:12.5px;font-weight:600;color:var(--muted);padding:6px 12px;border-radius:var(--pill);transition:background var(--t),color var(--t); }
.rc-preset:hover{ color:var(--ink); }
.rc-preset.on{ background:var(--accent);color:#fff;box-shadow:0 4px 10px -3px var(--accent-ring); }
.rc-preset:focus-visible{ outline:none;box-shadow:0 0 0 2px var(--accent-ring); }
.rc-fuelrow .rc-sfx{ margin-left:auto;width:90px; }

/* buttons + links */
.rc-btn{ font-size:12.5px;font-weight:600;padding:9px 16px;border-radius:var(--pill);background:#eceef3;color:var(--ink);transition:background var(--t),transform var(--t),box-shadow var(--t); }
.rc-btn:hover{ background:#e2e5ec; }
.rc-btn:active{ transform:translateY(1px); }
.rc-btn:focus-visible{ outline:none;box-shadow:0 0 0 2px var(--accent-ring); }
.rc-btn.primary{ background:var(--accent);color:#fff;box-shadow:0 4px 12px -3px var(--accent-ring); }
.rc-btn.primary:hover{ background:var(--accent-d); }
.rc-link{ align-self:flex-start;font-size:12px;font-weight:600;color:var(--accent);transition:color var(--t); }
.rc-link:hover{ color:var(--accent-d); }
.rc-addbox{ display:flex;gap:var(--s2);flex-wrap:wrap;margin-top:var(--s1); }
.rc-addbox .nm{ flex:1 1 130px; } .rc-addbox .mk{ width:74px;flex:0 0 auto;text-align:center; }

/* disclosure */
.rc-adv{ display:flex;align-items:center;gap:var(--s2);width:100%;padding:13px var(--s5);border-top:1px solid var(--line);color:var(--muted);font-size:12.5px;font-weight:600;text-align:left;transition:color var(--t); }
.rc-adv:hover{ color:var(--ink); }
.rc-tw{ font-size:9px;color:var(--faint);transition:transform var(--t); }
.rc-adv.open .rc-tw{ transform:rotate(90deg); }
.rc-advbody{ padding:0 var(--s5) var(--s4);display:flex;flex-direction:column;gap:var(--s4); }
.rc-advnote{ font-size:11.5px;color:var(--muted);line-height:1.55;background:var(--bg);border-radius:var(--ri);padding:12px 13px; }

/* footer */
.rc-foot{ padding:var(--s4) var(--s5) var(--s5);border-top:1px solid var(--line); }
.rc-note{ display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--muted);line-height:1.55;font-weight:500; }
.rc-notedot{ flex:0 0 auto;width:7px;height:7px;border-radius:50%;margin-top:5px;background:var(--muted); }
.rc-note.ok .rc-notedot{ background:var(--ok); } .rc-note.warn .rc-notedot{ background:var(--warn); }
.rc-prov{ margin-top:var(--s3);font-size:11px;color:var(--faint);line-height:1.6;font-weight:500; }
.rc-prov b{ color:var(--muted);font-weight:700; }

/* tables */
.rc-tblwrap{ padding:var(--s2) var(--s5) var(--s4);overflow-x:auto; }
.rc-tbl{ width:100%;border-collapse:collapse; }
.rc-tbl th,.rc-tbl td{ padding:10px 8px;text-align:right;border-bottom:1px solid var(--line); }
.rc-tbl th{ font-size:10px;font-weight:700;color:var(--faint);text-transform:uppercase;letter-spacing:.05em; }
.rc-tbl td{ font-size:13px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums; }
.rc-tbl th:first-child,.rc-tbl td:first-child{ text-align:left; }
.rc-tbl td.brk{ font-size:12.5px;color:var(--muted);font-weight:600; }
.rc-tbl td.est{ color:var(--faint);font-style:italic;font-weight:500; }
.rc-tbl tr:last-child td{ border-bottom:none; }

/* charts */
.rc-barlbl{ fill:var(--muted);font-size:11px;font-weight:600;font-family:'Montserrat',sans-serif; }
.rc-barval{ fill:var(--ink);font-size:11px;font-weight:700;font-family:'Montserrat',sans-serif; }

/* zone cards */
.rc-zwrap{ display:flex;flex-direction:column;gap:var(--s4); }
.rc-zhd{ display:flex;justify-content:space-between;align-items:flex-start;padding:var(--s5) var(--s5) 0;gap:var(--s3); }
.rc-zname{ font-size:15px;font-weight:600;color:var(--ink); }
.rc-zct{ font-size:11.5px;color:var(--muted);margin-top:2px;font-weight:500; }
.rc-zmin{ font-size:22px;font-weight:700;color:var(--ink);text-align:right;font-variant-numeric:tabular-nums; }
.rc-zminl{ font-size:10px;color:var(--faint);text-align:right;text-transform:uppercase;letter-spacing:.05em;margin-top:1px;font-weight:600; }
.rc-zbody{ padding:var(--s3) var(--s5) var(--s5); }
.rc-zrate{ font-size:11.5px;color:var(--muted);line-height:1.6;font-weight:500; }
.rc-zrate b{ color:var(--ink);font-weight:700; }
.rc-zips{ display:flex;flex-wrap:wrap;gap:5px;margin-top:var(--s3); }
.rc-zchip{ font-size:11px;font-weight:600;color:var(--muted);background:var(--bg);border-radius:6px;padding:3px 8px; }
.rc-zmore{ margin-top:var(--s3);font-size:11.5px;font-weight:600;color:var(--accent);transition:color var(--t); }
.rc-zmore:hover{ color:var(--accent-d); }
.rc-pfx{ margin-top:var(--s3);font-size:11px;color:var(--faint);font-weight:500; }
.rc-pfx b{ color:var(--muted);font-weight:700; }

.rc-pagefoot{ text-align:center;margin-top:var(--s4);font-size:11px;color:var(--faint);font-weight:500; }
`;
function i0({ value: e, set: t, min: n = 0 }) {
  return /* @__PURE__ */ a("div", { className: "rc-step", children: [
    /* @__PURE__ */ r("button", { onClick: () => t(Math.max(n, e - 1)), disabled: e <= n, "aria-label": "decrease", children: "−" }),
    /* @__PURE__ */ r("span", { className: "rc-count", children: e }),
    /* @__PURE__ */ r("button", { onClick: () => t(e + 1), "aria-label": "increase", children: "+" })
  ] });
}
const D = "uline_customer_profiles_v1", l0 = [
  { id: "list", name: "List (Uline)", markup: 0, locked: !0 },
  { id: "retail", name: "Retail +15%", markup: 15 }
], F = typeof window < "u" && window.storage && typeof window.storage.get == "function" ? { get: (e) => window.storage.get(e), set: (e, t) => window.storage.set(e, t) } : typeof window < "u" && window.localStorage ? {
  get: async (e) => {
    const t = window.localStorage.getItem(e);
    return t == null ? null : { value: t };
  },
  set: async (e, t) => (window.localStorage.setItem(e, t), { value: t })
} : { get: async () => null, set: async () => null };
function w({ label: e, hint: t, children: n, full: c }) {
  return /* @__PURE__ */ a("div", { className: "rc-field" + (c ? " col" : ""), children: [
    /* @__PURE__ */ a("span", { className: "rc-label", children: [
      e,
      t && /* @__PURE__ */ r("span", { className: "rc-hint", children: t })
    ] }),
    n
  ] });
}
function ne({ tab: e, setTab: t }) {
  return /* @__PURE__ */ r("div", { className: "rc-tabs", role: "tablist", children: [["quote", "Quote"], ["zones", "Zones"], ["sheet", "Rate sheet"]].map(([n, c]) => /* @__PURE__ */ r("button", { role: "tab", "aria-selected": e === n, className: "rc-tab" + (e === n ? " on" : ""), onClick: () => t(n), children: c }, n)) });
}
function oe({ accentHex: e }) {
  const t = [["Z1", 65.77], ["Z2", 68.67], ["Z3", 71.58], ["Z4", 103.01]], n = 103.01, c = 320, i = 96, l = 46, d = (c - 4 * l) / 5;
  return /* @__PURE__ */ r("svg", { viewBox: `0 0 ${c} ${i}`, style: { display: "block", width: "100%", height: "auto" }, role: "img", "aria-label": "Minimum charge by zone", children: t.map(([h, u], k) => {
    const p = (i - 30) * (u / n), g = d + k * (l + d), N = i - 20 - p;
    return /* @__PURE__ */ a("g", { children: [
      /* @__PURE__ */ r("rect", { x: g, y: N, width: l, height: p, rx: "5", fill: e, opacity: "0.88" }),
      /* @__PURE__ */ r("text", { x: g + l / 2, y: i - 5, textAnchor: "middle", className: "rc-barlbl", children: h }),
      /* @__PURE__ */ a("text", { x: g + l / 2, y: N - 5, textAnchor: "middle", className: "rc-barval", children: [
        "$",
        Math.round(u)
      ] })
    ] }, h);
  }) });
}
function R({ k: e, v: t, disc: n }) {
  return /* @__PURE__ */ a("div", { className: "rc-lrow", children: [
    /* @__PURE__ */ r("span", { className: "rc-lk", children: e }),
    /* @__PURE__ */ r("span", { className: "rc-lv" + (n ? " disc" : ""), children: t })
  ] });
}
function ce({ profiles: e, profileId: t, marginPct: n, curProfile: c, showAdd: i, newName: l, newMk: d, selectProfile: h, saveProfile: u, deleteProfile: k, setShowAdd: p, setNewName: g, setNewMk: N }) {
  return /* @__PURE__ */ a(w, { full: !0, label: "Customer profile", hint: "Applies a saved markup or discount", children: [
    /* @__PURE__ */ a("select", { className: "rc-select", value: t, onChange: (b) => h(b.target.value), children: [
      e.map((b) => /* @__PURE__ */ a("option", { value: b.id, children: [
        b.name,
        b.id !== "list" ? `  (${b.markup > 0 ? "+" : ""}${b.markup}%)` : ""
      ] }, b.id)),
      t === "__custom__" && /* @__PURE__ */ a("option", { value: "__custom__", children: [
        "Custom (",
        n > 0 ? "+" : "",
        n,
        "%)"
      ] }),
      /* @__PURE__ */ r("option", { value: "__add__", children: "+ Add customer profile…" })
    ] }),
    i && /* @__PURE__ */ a("div", { className: "rc-addbox", children: [
      /* @__PURE__ */ r("input", { className: "rc-input nm", placeholder: "Customer name", value: l, onChange: (b) => g(b.target.value) }),
      /* @__PURE__ */ r("input", { className: "rc-input mk", inputMode: "decimal", placeholder: "%", value: d, onChange: (b) => N(b.target.value.replace(/[^0-9.\-]/g, "")) }),
      /* @__PURE__ */ r("button", { className: "rc-btn primary", onClick: u, children: "Save" }),
      /* @__PURE__ */ r("button", { className: "rc-btn", onClick: () => {
        p(!1), g(""), N("");
      }, children: "Cancel" })
    ] }),
    c && !c.locked && t !== "__custom__" && !i && /* @__PURE__ */ a("button", { className: "rc-link", onClick: k, children: [
      'Delete "',
      c.name,
      '"'
    ] })
  ] });
}
function ie({ name: e, info: t, rateRow: n }) {
  const [c, i] = f(!1);
  return /* @__PURE__ */ a("div", { className: "rc-card", style: { marginBottom: 0 }, children: [
    /* @__PURE__ */ a("div", { className: "rc-zhd", children: [
      /* @__PURE__ */ a("div", { children: [
        /* @__PURE__ */ a("div", { className: "rc-zname", children: [
          "Zone ",
          e
        ] }),
        /* @__PURE__ */ a("div", { className: "rc-zct", children: [
          t.zips.length,
          " ZIPs",
          t.pfx.length ? ` · ${t.pfx.length} area fallbacks` : ""
        ] })
      ] }),
      /* @__PURE__ */ a("div", { children: [
        /* @__PURE__ */ a("div", { className: "rc-zmin", children: [
          "$",
          S(t.min)
        ] }),
        /* @__PURE__ */ r("div", { className: "rc-zminl", children: "min charge" })
      ] })
    ] }),
    /* @__PURE__ */ a("div", { className: "rc-zbody", children: [
      /* @__PURE__ */ a("div", { className: "rc-zrate", children: [
        "All-in @ 28%, single pallet — ",
        /* @__PURE__ */ a("b", { children: [
          "$",
          n["500 - 999"]
        ] }),
        " at 500–999 lb · ",
        /* @__PURE__ */ a("b", { children: [
          "$",
          n["1,000 - 2,499"]
        ] }),
        " at 1,000–2,499 lb"
      ] }),
      /* @__PURE__ */ r("div", { className: "rc-zips", children: (c ? t.zips : t.zips.slice(0, 24)).map((l) => /* @__PURE__ */ r("span", { className: "rc-zchip", children: l }, l)) }),
      t.zips.length > 24 && /* @__PURE__ */ r("button", { className: "rc-zmore", onClick: () => i(!c), children: c ? "Show fewer" : `Show all ${t.zips.length} ZIPs` }),
      t.pfx.length > 0 && /* @__PURE__ */ a("div", { className: "rc-pfx", children: [
        "Area fallbacks (3-digit): ",
        /* @__PURE__ */ r("b", { children: t.pfx.join(", ") })
      ] })
    ] })
  ] });
}
function le() {
  return /* @__PURE__ */ a("div", { className: "rc-card", children: [
    /* @__PURE__ */ a("div", { className: "rc-chead", children: [
      /* @__PURE__ */ r("div", { className: "rc-ccat", children: "All-in @ 28% fuel" }),
      /* @__PURE__ */ r("h3", { className: "rc-ctitle", children: "Rate sheet by weight break" }),
      /* @__PURE__ */ r("p", { className: "rc-csub", children: "Single pallet, normalized across 18 months. Italic cells (5,000 lb+) are thin on Uline volume — loose and bulky freight rates higher." })
    ] }),
    /* @__PURE__ */ r("div", { className: "rc-tblwrap", children: /* @__PURE__ */ a("table", { className: "rc-tbl", children: [
      /* @__PURE__ */ r("thead", { children: /* @__PURE__ */ a("tr", { children: [
        /* @__PURE__ */ r("th", { children: "Weight (lb)" }),
        /* @__PURE__ */ r("th", { children: "Z1" }),
        /* @__PURE__ */ r("th", { children: "Z2" }),
        /* @__PURE__ */ r("th", { children: "Z3" }),
        /* @__PURE__ */ r("th", { children: "Z4" })
      ] }) }),
      /* @__PURE__ */ r("tbody", { children: q.breaks.map((e) => /* @__PURE__ */ a("tr", { children: [
        /* @__PURE__ */ r("td", { className: "brk", children: e }),
        ["Z1", "Z2", "Z3", "Z4"].map((t) => /* @__PURE__ */ a("td", { className: q.estCells[t].includes(e) ? "est" : "", children: [
          "$",
          S(q.rateSheet[t][e])
        ] }, t))
      ] }, e)) })
    ] }) })
  ] });
}
function ue({ model: e, modelUrl: t, initialZip: n, initialWeight: c, initialSkids: i, initialLoose: l, embedded: d } = {}) {
  const [h] = f("blue"), [u, k] = f("quote"), [p, g] = f(n != null ? String(n).replace(/[^0-9]/g, "").slice(0, 5) : "30127"), [N, b] = f(c != null ? String(Math.max(0, Math.round(Number(c) || 0))) : "1330"), [K, p0] = f(i != null ? Number(i) : 3), [y, h0] = f(l != null ? Number(l) : 0), [z, M] = f("28"), [O, P] = f("0"), [A, E] = f(l0), [J, Z] = f("list"), [u0, W] = f(!1), [I, L] = f(""), [B, X] = f(""), [G, Y] = f(0);
  T(() => {
    if (e && e.zone5) {
      q = e, Y((o) => o + 1);
      return;
    }
    if (t) {
      let o = !0;
      return fetch(t).then((s) => s.json()).then((s) => {
        o && s && s.zone5 && (q = s, Y((v) => v + 1));
      }).catch(() => {
      }), () => {
        o = !1;
      };
    }
  }, [e, t]), T(() => {
    (async () => {
      try {
        const o = await F.get(D);
        if (o && o.value) {
          const s = JSON.parse(o.value);
          Array.isArray(s) && s.length && E(s);
        } else
          await F.set(D, JSON.stringify(l0));
      } catch {
      }
    })();
  }, []);
  const $ = async (o) => {
    E(o);
    try {
      await F.set(D, JSON.stringify(o));
    } catch {
    }
  }, f0 = (o) => {
    if (o === "__add__") {
      W(!0);
      return;
    }
    const s = A.find((v) => v.id === o);
    s && (Z(o), P(String(s.markup)));
  }, g0 = () => {
    const o = I.trim();
    if (!o) return;
    const s = Number(B) || 0, v = "p" + Date.now(), U = [...A, { id: v, name: o, markup: s }];
    $(U), Z(v), P(String(s)), W(!1), L(""), X("");
  }, b0 = () => {
    const o = A.find((v) => v.id === J);
    if (!o || o.locked) return;
    const s = A.filter((v) => v.id !== J);
    $(s), Z("list"), P("0");
  }, m0 = (o) => {
    P(o), Z("__custom__");
  }, x = o0(() => {
    const o = Number(N) || 0, s = (Number(z) || 0) / 100, v = (Number(O) || 0) / 100, U = _0(p, o, K, y), C = U.lh * (1 + s), a0 = C * (1 + v), q0 = Math.max(K + y, 1), n0 = String(p) in q.zone5;
    return { zb: U.zb, lh: U.lh, fuelAmt: U.lh * s, allIn: C, quoted: a0, marginAmt: a0 - C, zipFound: n0, conf: ee(n0, q0, o, y) };
  }, [p, N, K, y, z, O, G]), _ = w0(null);
  T(() => {
    const o = _.current;
    o && (o.classList.remove("rc-anim"), o.offsetWidth, o.classList.add("rc-anim"));
  }, [x.quoted]);
  const e0 = Number(z) || 0, m = Number(O) || 0, r0 = m === 0 ? "" : m > 0 ? `+${m}% margin` : `${m}% discount`, V = A.find((o) => o.id === J), v0 = V && V.id !== "list" && V.id !== "__custom__" ? " · " + V.name : "", x0 = `${m === 0 ? "all-in" : "quote"} · ${e0}% fuel${r0 ? " · " + r0 : ""}${v0}`, t0 = x.conf.key === "core" ? "ok" : x.conf.key === "est" ? "warn" : "", k0 = o0(() => $0(q), [G]), N0 = { "--accent": c0[h], "--accent-d": re[h], "--accent-ring": te[h] };
  return /* @__PURE__ */ a("div", { className: "rc-root" + (d ? " rc-embedded" : ""), style: N0, children: [
    /* @__PURE__ */ r("style", { children: ae }),
    /* @__PURE__ */ a("div", { className: "rc-wrap", children: [
      /* @__PURE__ */ a("header", { className: "rc-head", children: [
        /* @__PURE__ */ a("div", { className: "rc-brand", children: [
          /* @__PURE__ */ r("img", { className: "rc-logoimg", src: E0, alt: "Davis Delivery Service" }),
          /* @__PURE__ */ r("div", { className: "rc-bs", children: "Uline Rate Console" })
        ] }),
        /* @__PURE__ */ r("div", { className: "rc-right", children: /* @__PURE__ */ r("span", { className: "rc-ver", children: M0 }) })
      ] }),
      /* @__PURE__ */ r(ne, { tab: u, setTab: k }),
      u === "quote" && /* @__PURE__ */ a(j, { children: [
        /* @__PURE__ */ a("div", { className: "rc-hero", children: [
          /* @__PURE__ */ r("div", { className: "rc-cat", children: m === 0 ? "All-in quote" : "Customer quote" }),
          /* @__PURE__ */ a("div", { className: "rc-price", children: [
            /* @__PURE__ */ r("span", { className: "rc-cur", children: "$" }),
            /* @__PURE__ */ r("span", { className: "rc-amt", ref: _, children: S(x.quoted) })
          ] }),
          /* @__PURE__ */ r("div", { className: "rc-sub", children: x0 }),
          /* @__PURE__ */ a("div", { className: "rc-hstatus", children: [
            /* @__PURE__ */ a("span", { className: "rc-hpill " + t0, children: [
              /* @__PURE__ */ r("span", { className: "rc-hdot" }),
              x.conf.label
            ] }),
            /* @__PURE__ */ a("span", { className: "rc-hpill", children: [
              "zone ",
              B0(x.zb)
            ] }),
            /* @__PURE__ */ r("span", { className: "rc-hpill", children: String(p).slice(0, 5) || "—" })
          ] })
        ] }),
        /* @__PURE__ */ a("div", { className: "rc-card", children: [
          /* @__PURE__ */ a("div", { className: "rc-chead", children: [
            /* @__PURE__ */ r("div", { className: "rc-ccat", children: "Breakdown" }),
            /* @__PURE__ */ r("h3", { className: "rc-ctitle", children: "Charge detail" })
          ] }),
          /* @__PURE__ */ a("div", { className: "rc-ledger", children: [
            /* @__PURE__ */ r(R, { k: "Linehaul", v: "$" + S(x.lh) }),
            /* @__PURE__ */ r(R, { k: `Fuel · ${e0}%`, v: "$" + S(x.fuelAmt) }),
            m !== 0 && /* @__PURE__ */ r(R, { k: `${m > 0 ? "Margin" : "Discount"} · ${m > 0 ? "+" : ""}${m}%`, v: (m < 0 ? "−" : "+") + "$" + S(Math.abs(x.marginAmt)), disc: m < 0 }),
            /* @__PURE__ */ a("div", { className: "rc-lrow tot", children: [
              /* @__PURE__ */ r("span", { className: "rc-lk", children: "Quote" }),
              /* @__PURE__ */ a("span", { className: "rc-lv", children: [
                "$",
                S(x.quoted)
              ] })
            ] })
          ] }),
          /* @__PURE__ */ r("div", { className: "rc-divhd", children: "Shipment" }),
          /* @__PURE__ */ a("div", { className: "rc-form", children: [
            /* @__PURE__ */ r(
              ce,
              {
                profiles: A,
                profileId: J,
                marginPct: m,
                curProfile: V,
                showAdd: u0,
                newName: I,
                newMk: B,
                selectProfile: f0,
                saveProfile: g0,
                deleteProfile: b0,
                setShowAdd: W,
                setNewName: L,
                setNewMk: X
              }
            ),
            /* @__PURE__ */ r(w, { label: "Destination ZIP", hint: "Sets the rate zone", children: /* @__PURE__ */ r("input", { className: "rc-input", inputMode: "numeric", maxLength: 5, value: p, onChange: (o) => g(o.target.value.replace(/[^0-9]/g, "").slice(0, 5)) }) }),
            /* @__PURE__ */ r(w, { label: "Weight", hint: "Total pounds", children: /* @__PURE__ */ r("input", { className: "rc-input", inputMode: "numeric", value: N, onChange: (o) => b(o.target.value.replace(/[^0-9]/g, "")) }) }),
            /* @__PURE__ */ r(w, { label: "Skids", hint: "Pallet count", children: /* @__PURE__ */ r(i0, { value: K, set: p0, min: 0 }) }),
            /* @__PURE__ */ r(w, { label: "Loose pieces", hint: "Non-palletized", children: /* @__PURE__ */ r(i0, { value: y, set: h0, min: 0 }) }),
            /* @__PURE__ */ r(w, { full: !0, label: "Fuel surcharge", hint: "2025: 23% → 20% (Jun 14) · 2026: 25% (Mar 21) → 28% (Apr 20)", children: /* @__PURE__ */ a("div", { className: "rc-fuelrow", children: [
              /* @__PURE__ */ r("div", { className: "rc-presets", children: ["20", "23", "25", "28"].map((o) => /* @__PURE__ */ a("button", { className: "rc-preset" + (z === o ? " on" : ""), onClick: () => M(o), children: [
                o,
                "%"
              ] }, o)) }),
              /* @__PURE__ */ a("div", { className: "rc-sfx", children: [
                /* @__PURE__ */ r("input", { inputMode: "decimal", value: z, onChange: (o) => M(o.target.value.replace(/[^0-9.]/g, "")) }),
                /* @__PURE__ */ r("span", { className: "rc-unit", children: "%" })
              ] })
            ] }) }),
            /* @__PURE__ */ r(w, { full: !0, label: "Margin / discount", hint: "+ markup or − discount on the quote", children: /* @__PURE__ */ a("div", { className: "rc-sfx rc-narrow", children: [
              /* @__PURE__ */ r("input", { inputMode: "decimal", value: O, onChange: (o) => m0(o.target.value.replace(/[^0-9.\-]/g, "")) }),
              /* @__PURE__ */ r("span", { className: "rc-unit", children: "%" })
            ] }) })
          ] }),
          /* @__PURE__ */ a("div", { className: "rc-foot", children: [
            /* @__PURE__ */ a("div", { className: "rc-note " + t0, children: [
              /* @__PURE__ */ r("span", { className: "rc-notedot" }),
              x.conf.note
            ] }),
            /* @__PURE__ */ a("div", { className: "rc-prov", children: [
              "Modeled from ",
              /* @__PURE__ */ r("b", { children: "226,073" }),
              " Uline shipments · ",
              /* @__PURE__ */ r("b", { children: "Jan 2025 – Jun 2026" }),
              ". Base rate flat 18 months. Uline bills on ",
              /* @__PURE__ */ r("b", { children: "weight and zone" }),
              " — freight class and density don't change the rate (verified on 4,737 shipments). Pallet freight matches within $5 on ~94%."
            ] })
          ] })
        ] })
      ] }),
      u === "zones" && /* @__PURE__ */ a(j, { children: [
        /* @__PURE__ */ a("div", { className: "rc-card", children: [
          /* @__PURE__ */ a("div", { className: "rc-chead", children: [
            /* @__PURE__ */ r("div", { className: "rc-ccat", children: "Minimum charge" }),
            /* @__PURE__ */ r("h3", { className: "rc-ctitle", children: "Rate zones" }),
            /* @__PURE__ */ r("p", { className: "rc-csub", children: "Set by destination ZIP. Zones differ almost entirely by minimum charge — per-pound rates are nearly identical (short-haul metro / North GA). Z4 is the far / special tier." })
          ] }),
          /* @__PURE__ */ r("div", { className: "rc-tblwrap", children: /* @__PURE__ */ r(oe, { accentHex: c0[h] }) })
        ] }),
        /* @__PURE__ */ r("div", { className: "rc-zwrap", children: ["Z1", "Z2", "Z3", "Z4"].map((o) => /* @__PURE__ */ r(ie, { name: o, info: k0[o], rateRow: q.rateSheet[o] }, o)) })
      ] }),
      u === "sheet" && /* @__PURE__ */ a(j, { children: [
        /* @__PURE__ */ r(le, {}),
        /* @__PURE__ */ r("div", { className: "rc-card", children: /* @__PURE__ */ r("div", { className: "rc-foot", style: { borderTop: "none" }, children: /* @__PURE__ */ r("div", { className: "rc-prov", children: "Per-CWT rates decline by weight break: ≈$26/cwt at the minimum, ≈$11/cwt at 500–1,000 lb, ≈$7/cwt at 1,000–2,500 lb. Quote a live figure on the Quote tab." }) }) })
      ] }),
      !d && /* @__PURE__ */ r("div", { className: "rc-pagefoot", children: "Modeled estimate from billing history · not a published Uline tariff" })
    ] })
  ] });
}
export {
  ue as UlineQuoteConsole,
  he as defaultModel,
  pe as priceQuote
};
