# TiffyCooks Enhanced REST API

An enhanced REST API for TiffyCooks content that extends the WordPress REST API with additional features, media processing, and structured data.

## Features

### Enhanced Content
- Structured recipe data extraction
- Rich media content processing
- Automated video generation
- YouTube video metadata enhancement
- Category icons and metadata
- Author details enrichment

### Media Processing
- Automatic TikTok-style video generation
- Blurred background for landscape images
- YouTube video metadata enhancement
- Image and video extraction from content
- Featured media optimization

### Background Tasks
- Automated video generation every 4 hours
- Daily content synchronization
- Rate-limited processing
- Progress tracking for video generation
- Error handling and retry mechanisms

### Security
- API key authentication
- Rate limiting
- CORS protection
- Content sanitization
- Security headers (via Helmet)
- Error handling

## API Endpoints

### Posts (`/api/posts`)
```javascript
GET /api/posts
Parameters:
- per_page (optional): Number of posts to return
- generate_video (optional): Generate video for posts
```

### Categories (`/api/categories`)
```javascript
GET /api/categories
Returns categories with icons and metadata
```

### Pages (`/api/pages`)
```javascript
GET /api/pages
Returns static pages with enhanced media
```

### Comments (`/api/comments`)
```javascript
GET /api/comments
Returns post comments with author details
```

### Documentation (`/api/docs`)
```javascript
GET /api/docs
Returns API documentation and usage details
```

### Health Check (`/health`)
```javascript
GET /health
Returns API health status
```

## Setup

1. Clone the repository:
```bash
git clone https://github.com/paulchrisluke/tiffy-cooks-rest-api.git
cd tiffy-cooks-rest-api
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file:
```env
PORT=3000
YOUTUBE_API_KEY=your_youtube_api_key
BLOB_READ_WRITE_TOKEN=your_vercel_blob_token
API_KEY=your_api_key
ALLOWED_ORIGINS=http://localhost:3000,https://yourdomain.com
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

4. Start the server:
```bash
# Development
npm run dev

# Production
npm start
```

## Authentication

Include the API key in the request headers:
```javascript
headers: {
  'x-api-key': 'your_api_key'
}
```

## Rate Limiting

- 100 requests per 15 minutes by default
- Configurable via environment variables
- Applies per IP address

## Video Generation

Videos are automatically generated for posts with images:
- Vertical format (1080x1920)
- Blurred background for landscape images
- Transitions between images
- Generated every 4 hours for new content
- Stored in Vercel Blob storage

## Dependencies

- Express.js - Web framework
- node-cron - Task scheduling
- FFmpeg - Video processing
- JSDOM - HTML parsing
- Vercel Blob - Video storage
- YouTube API - Video metadata
- Helmet - Security headers
- Express Rate Limit - Rate limiting
- Sanitize HTML - Content sanitization

## Deployment

The API is designed to be deployed on Vercel:
1. Connect your GitHub repository to Vercel
2. Configure environment variables
3. Deploy

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Run in production mode
npm start
```

## License

MIT License

## Author

Paul Chris Luke 