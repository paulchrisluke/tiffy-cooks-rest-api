# TiffyCooks Enhanced REST API

This API enhances the TiffyCooks WordPress REST API by providing enriched post data with better organized metadata.

## Features

- Fetches posts from TiffyCooks WordPress API
- Enriches post data with:
  - Author details (name and avatar)
  - Categories with full information
  - Featured media with all available sizes
  - Tags
  - ACF custom fields (if any)
  - Complete metadata

## Setup

1. Install dependencies:
```bash
npm install
```

2. Run locally:
```bash
npm run dev
```

## API Endpoints

- `GET /api/posts` - Get enriched posts data
- `GET /` - API information and available endpoints

## Deployment

This API is configured for deployment on Vercel. To deploy:

1. Install Vercel CLI:
```bash
npm i -g vercel
```

2. Deploy:
```bash
vercel
``` 