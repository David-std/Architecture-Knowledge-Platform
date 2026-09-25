import fs from "node:fs";
import { NextResponse } from "next/server";

export async function GET() {
  const customPath = process.env.AKP_ARTWORK_PATH;
  if (customPath) {
    try {
      if (fs.existsSync(customPath)) {
        const buffer = fs.readFileSync(customPath);
        return new NextResponse(buffer, {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control":
              "public, max-age=86400, stale-while-revalidate=604800",
          },
        });
      }
    } catch {
      // Fallback below
    }
  }

  // Generative SVG Architectural Pavilion fallback
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450" width="100%" height="100%">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#fdfbf7" />
        <stop offset="100%" stop-color="#f5efe6" />
      </linearGradient>
      <linearGradient id="terracotta" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ea580c" />
        <stop offset="100%" stop-color="#c2410c" />
      </linearGradient>
      <linearGradient id="amber" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.85" />
        <stop offset="100%" stop-color="#d97706" stop-opacity="0.9" />
      </linearGradient>
      <linearGradient id="slate" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#334155" />
        <stop offset="100%" stop-color="#1e293b" />
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)" />
    <g transform="translate(400, 225)">
      <!-- Architectural Interlocking Geometry -->
      <polygon points="-120,-60 60,-150 160,-80 -20,10" fill="url(#slate)" opacity="0.9" />
      <polygon points="-80,20 100,-70 200,0 20,90" fill="url(#terracotta)" />
      <polygon points="-160,40 -20,-40 80,30 -60,110" fill="#e2d9cc" stroke="#c8beaf" stroke-width="2" />
      <polygon points="-40,-110 140,-190 220,-130 40,-50" fill="url(#amber)" />
      <polygon points="-10,50 120,-20 180,30 50,100" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5" />
      <line x1="-120" y1="-60" x2="-120" y2="40" stroke="#0f172a" stroke-width="3" />
      <line x1="60" y1="-150" x2="60" y2="-50" stroke="#c2410c" stroke-width="3" />
      <line x1="160" y1="-80" x2="160" y2="20" stroke="#d97706" stroke-width="2" />
      <circle cx="-20" cy="10" r="4" fill="#c2410c" />
      <circle cx="80" cy="30" r="4" fill="#0f172a" />
      <circle cx="100" cy="-70" r="4" fill="#d97706" />
    </g>
  </svg>`;

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}
