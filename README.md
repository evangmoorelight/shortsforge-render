# ShortsForge – GitHub + Render setup

## Important source-video limitation
This version analyzes a public YouTube watch URL with Gemini, but renders MP4 from a **direct video-file URL** (for example, an MP4 hosted in your own storage/website). It does not download arbitrary YouTube watch pages or bypass YouTube restrictions. Use only video you own or are authorized to process.

## Deploy from an Android phone
1. Create a GitHub repository named `shortsforge-render`.
2. Upload all files/folders from this project, keeping `public/index.html`, `server.js`, and `package.json` in the root structure.
3. In Render, create a **New Web Service** and connect that GitHub repository.
4. Set:
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variable: `GEMINI_API_KEY` = your Gemini API key
5. Deploy. Open the Render URL on your phone.

## FFmpeg requirement
The server needs FFmpeg installed. On a Render service, use a Docker deployment if the selected runtime does not include FFmpeg. A Dockerfile is included below.

## Local test
Install Node.js 18+ and FFmpeg, then run:
```bash
npm install
npm start
```
Open `http://localhost:3000`.

## Notes
- The app stores a Gemini key in `data/settings.json` if entered in Settings. Prefer Render's private `GEMINI_API_KEY` environment variable for a public deployment.
- Add persistent disk storage if you want generated MP4s to remain available after server restarts. Without it, output files are temporary.
- This is a starter deployment. Add authentication, rate limits, storage cleanup, and a persistent disk before public production use.
