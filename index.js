const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { body, validationResult } = require('express-validator');
const sanitizeHtml = require('sanitize-html');
require('dotenv').config();
const { extractYoutubeVideoId, getEnhancedYoutubeData, generateVideoFromImages } = require('./utils/videoProcessor');
const { processPostsForVideos, processedPosts } = require('./utils/backgroundTasks');

const app = express();
const port = process.env.PORT || 3000;

// Security middleware
app.use(helmet());

// Rate limiting
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100
});
app.use(limiter);

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// API key middleware
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Invalid or missing API key'
        });
    }
    
    next();
};

// Apply API key validation to all routes
app.use(validateApiKey);

// Sanitize HTML content
const sanitizeContent = (content) => {
    return sanitizeHtml(content, {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'video', 'iframe']),
        allowedAttributes: {
            ...sanitizeHtml.defaults.allowedAttributes,
            img: ['src', 'alt', 'title', 'width', 'height', 'data-caption'],
            video: ['src', 'poster', 'width', 'height'],
            iframe: ['src', 'width', 'height', 'title']
        }
    });
};

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

const WORDPRESS_API_URL = 'https://tiffycooks.com/wp-json/wp/v2';

// Helper function to extract author details
function extractAuthorDetails(post) {
    try {
        // Default values
        const defaultAuthor = {
            id: post.author,
            name: 'Tiffy Cooks',
            avatar: 'https://tiffycooks.com/wp-content/uploads/2024/01/cropped-tiffy-cooks-logo-1.png',
            social: [
                'https://www.youtube.com/@tiffyycooks',
                'https://www.tiktok.com/@tiffycooks',
                'https://www.instagram.com/tiffy.cooks/'
            ],
            url: 'https://tiffycooks.com'
        };

        const yoastData = post.yoast_head_json?.schema?.['@graph'] || [];
        
        // First try to get author from Article schema
        const articleData = yoastData.find(item => item['@type'] === 'Article');
        if (articleData?.author?.name) {
            return {
                id: post.author,
                name: articleData.author.name,
                avatar: articleData.author.image?.url || defaultAuthor.avatar,
                social: defaultAuthor.social,
                url: articleData.author['@id']?.replace('/#/schema/person/', '') || defaultAuthor.url
            };
        }
        
        // Fallback to Organization data
        const organizationData = yoastData.find(item => item['@type'] === 'Organization');
        if (organizationData) {
            return {
                id: post.author,
                name: organizationData.name || defaultAuthor.name,
                avatar: organizationData.logo?.url || defaultAuthor.avatar,
                social: organizationData.sameAs || defaultAuthor.social,
                url: organizationData.url || defaultAuthor.url
            };
        }
        
        return defaultAuthor;
    } catch (error) {
        console.error('Error extracting author details:', error);
        return defaultAuthor;
    }
}

function defaultAuthorObject(post) {
    return {
        id: post.author,
        name: 'Tiffy Cooks',
        avatar: 'https://tiffycooks.com/wp-content/uploads/2024/01/cropped-tiffy-cooks-logo-1.png',
        social: [],
        url: 'https://tiffycooks.com'
    };
}

// Helper function to extract categories
const extractCategories = (post) => {
    return post._embedded?.['wp:term']?.[0]?.map(cat => ({
        id: cat.id,
        name: cat.name,
        slug: cat.slug
    })) || [];
};

// Helper function to extract featured media
const extractFeaturedMedia = (post) => {
    const media = post._embedded?.['wp:featuredmedia']?.[0];
    return media ? {
        url: media.source_url,
        alt: media.alt_text,
        title: media.title?.rendered,
        sizes: media.media_details?.sizes
    } : null;
};

// Helper function to get icon for category
function getCategoryIcon(category) {
    const iconMap = {
        // Food types
        'appetizers': 'utensils',
        'beef': 'burger',
        'better-than-takeout': 'shopping-bag',
        'breakfast': 'sun',
        'dessert': 'cake',
        'drinks': 'coffee',
        'noodles': 'noodles',
        'rice': 'bowl-rice',
        'seafood': 'fish',
        'snacks': 'cookie',
        'soups': 'soup',
        
        // Regions
        'asia': 'globe-asia',
        'americas': 'globe-americas',
        'europe': 'globe-europe',
        
        // Default
        'default': 'bookmark'
    };
    
    return iconMap[category.slug] || iconMap.default;
}

// Helper function to extract recipe data
function extractRecipeData(content) {
    if (!content) return null;
    
    // Create a temporary DOM element to parse HTML
    const tempDiv = new (require('jsdom').JSDOM)(`<!DOCTYPE html><div>${content}</div>`).window.document.querySelector('div');
    
    // Find the recipe container
    const recipeContainer = tempDiv.querySelector('.wprm-recipe-container');
    if (!recipeContainer) return null;
    
    return {
        name: recipeContainer.querySelector('.wprm-recipe-name')?.textContent?.trim(),
        summary: recipeContainer.querySelector('.wprm-recipe-summary')?.textContent?.trim(),
        meta: {
            activeTime: recipeContainer.querySelector('.wprm-recipe-cook_time')?.textContent?.trim(),
            totalTime: recipeContainer.querySelector('.wprm-recipe-total_time')?.textContent?.trim(),
            course: recipeContainer.querySelector('.wprm-recipe-course')?.textContent?.trim(),
            cuisine: recipeContainer.querySelector('.wprm-recipe-cuisine')?.textContent?.trim(),
            diet: recipeContainer.querySelector('.wprm-recipe-suitablefordiet')?.textContent?.trim(),
            keywords: recipeContainer.querySelector('.wprm-recipe-keyword')?.textContent?.trim()?.split(',').map(k => k.trim())
        },
        ingredients: Array.from(recipeContainer.querySelectorAll('.wprm-recipe-ingredient')).map(ingredient => ({
            amount: ingredient.querySelector('.wprm-recipe-ingredient-amount')?.textContent?.trim(),
            unit: ingredient.querySelector('.wprm-recipe-ingredient-unit')?.textContent?.trim(),
            name: ingredient.querySelector('.wprm-recipe-ingredient-name')?.textContent?.trim(),
            notes: ingredient.querySelector('.wprm-recipe-ingredient-notes')?.textContent?.trim()
        })),
        instructions: Array.from(recipeContainer.querySelectorAll('.wprm-recipe-instruction')).map(instruction => ({
            text: instruction.querySelector('.wprm-recipe-instruction-text')?.textContent?.trim(),
            image: instruction.querySelector('.wprm-recipe-instruction-image img')?.getAttribute('src')
        }))
    };
}

// Helper function to extract media from content
async function extractMediaFromContent(content, postTitle, shouldGenerateVideo = false) {
    if (!content) return { images: [], videos: [], generatedContent: null };

    const images = [];
    const videos = [];

    // Create a temporary DOM element to parse HTML
    const tempDiv = new (require('jsdom').JSDOM)(`<!DOCTYPE html><div>${content}</div>`).window.document.querySelector('div');

    // Extract images
    tempDiv.querySelectorAll('img').forEach(img => {
        images.push({
            url: img.src,
            alt: img.alt || '',
            title: img.title || '',
            width: img.width || null,
            height: img.height || null,
            caption: img.getAttribute('data-caption') || ''
        });
    });

    // Extract videos (including iframe embeds)
    const videoPromises = Array.from(tempDiv.querySelectorAll('video, iframe')).map(async video => {
        if (video.tagName === 'IFRAME') {
            const src = video.src;
            if (src.includes('youtube.com') || src.includes('youtu.be')) {
                const videoId = await extractYoutubeVideoId(src);
                if (videoId) {
                    const enhancedData = await getEnhancedYoutubeData(videoId);
                    if (enhancedData) {
                        videos.push(enhancedData);
                    }
                }
            } else if (src.includes('vimeo.com') || src.includes('tiktok.com')) {
                videos.push({
                    type: 'embed',
                    url: src,
                    width: video.width || null,
                    height: video.height || null,
                    title: video.title || ''
                });
            }
        } else {
            videos.push({
                type: 'video',
                url: video.src,
                poster: video.poster || null,
                width: video.width || null,
                height: video.height || null
            });
        }
    });

    // Wait for all video processing to complete
    await Promise.all(videoPromises);

    // Generate video content from images only if requested
    const generatedContent = shouldGenerateVideo && images.length > 0 
        ? await generateVideoFromImages(images, postTitle) 
        : null;

    return { images, videos, generatedContent };
}

app.get('/api/posts', async (req, res) => {
    try {
        console.log('Fetching posts...');
        const response = await axios.get(`${WORDPRESS_API_URL}/posts`, {
            params: {
                _embed: true,
                per_page: req.query.per_page || 10,
                orderby: 'date',
                order: 'desc'
            }
        });

        if (!Array.isArray(response.data)) {
            throw new Error('Expected an array of posts from WordPress API');
        }

        console.log(`Found ${response.data.length} posts`);

        const enrichedPosts = await Promise.all(response.data.map(async post => {
            console.log(`Processing post ${post.id}: ${post.title?.rendered}`);
            
            // Extract media from content with more detailed logging
            console.log('Extracting media from content...');
            const { images, videos, generatedContent } = await extractMediaFromContent(
                post.content?.rendered,
                post.title?.rendered || 'Untitled Post',
                req.query.generate_video === 'true' // Only generate video if explicitly requested
            );
            console.log(`Found ${images.length} images and ${videos.length} videos`);
            
            // Extract recipe data if available
            const recipe = extractRecipeData(post.content?.rendered);

            // Use our extractAuthorDetails function
            const author = extractAuthorDetails(post);

            // Extract featured media
            const featuredMedia = post._embedded?.['wp:featuredmedia']?.[0];
            const media = featuredMedia ? {
                id: featuredMedia.id,
                title: featuredMedia.title?.rendered,
                url: featuredMedia.source_url,
                alt: featuredMedia.alt_text,
                description: featuredMedia.description?.rendered,
                caption: featuredMedia.caption?.rendered,
                meta: {
                    width: featuredMedia.media_details?.width,
                    height: featuredMedia.media_details?.height,
                    sizes: featuredMedia.media_details?.sizes
                }
            } : null;

            // Extract categories and tags
            const categories = post._embedded?.['wp:term']?.[0]?.map(cat => ({
                id: cat.id,
                name: cat.name,
                slug: cat.slug,
                description: cat.description,
                link: cat.link
            })) || [];

            const tags = post._embedded?.['wp:term']?.[1]?.map(tag => ({
                id: tag.id,
                name: tag.name,
                slug: tag.slug,
                link: tag.link
            })) || [];

            return {
                id: post.id,
                title: post.title?.rendered,
                content: post.content?.rendered,
                excerpt: post.excerpt?.rendered,
                slug: post.slug,
                date: post.date,
                modified: post.modified,
                author,
                featuredMedia: media,
                contentMedia: {
                    images,
                    videos,
                    aiGeneratedFeaturedVideo: generatedContent
                },
                recipe, // Add the structured recipe data
                categories,
                tags,
                meta: {
                    ...post.meta,
                    yoast: post.yoast_head_json || {}
                },
                link: post.link,
                status: post.status,
                type: post.type,
                format: post.format,
                commentStatus: post.comment_status,
                pingStatus: post.ping_status,
                template: post.template
            };
        }));

        res.json({
            count: enrichedPosts.length,
            posts: enrichedPosts
        });
    } catch (error) {
        console.error('Error fetching posts:', error);
        res.status(error.response?.status || 500).json({ 
            error: 'Failed to fetch posts',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to fetch posts',
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

app.get('/api/categories', async (req, res) => {
    try {
        console.log('Fetching categories...');
        const response = await axios.get(`${WORDPRESS_API_URL}/categories`, {
            params: {
                per_page: 100,
                orderby: 'count',
                order: 'desc'
            }
        });

        if (!Array.isArray(response.data)) {
            throw new Error('Expected an array of categories from WordPress API');
        }

        console.log(`Found ${response.data.length} categories`);

        const enrichedCategories = response.data.map(category => {
            // Get breadcrumb from Yoast data
            const breadcrumb = category.yoast_head_json?.schema?.['@graph']?.find(item => item['@type'] === 'BreadcrumbList')?.itemListElement || [];
            
            return {
                id: category.id,
                name: category.name,
                slug: category.slug,
                description: category.description,
                count: category.count,
                link: category.link,
                parent: category.parent,
                icon: getCategoryIcon(category),
                meta: {
                    breadcrumb: breadcrumb.map(item => ({
                        name: item.name,
                        path: item.item || null
                    })),
                    yoast: category.yoast_head_json || {}
                }
            };
        });

        res.json({
            count: enrichedCategories.length,
            categories: enrichedCategories
        });
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({ 
            error: 'Failed to fetch categories',
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

app.get('/api/pages', async (req, res) => {
    try {
        console.log('Fetching pages...');
        const response = await axios.get(`${WORDPRESS_API_URL}/pages`, {
            params: {
                _embed: true,
                per_page: 100,
                orderby: 'menu_order',
                order: 'asc'
            }
        });

        if (!Array.isArray(response.data)) {
            throw new Error('Expected an array of pages from WordPress API');
        }

        console.log(`Found ${response.data.length} pages`);

        const enrichedPages = response.data.map(page => {
            console.log(`Processing page ${page.id}: ${page.title?.rendered}`);
            
            // Use our extractAuthorDetails function
            const author = extractAuthorDetails(page);

            // Extract featured media
            const featuredMedia = page._embedded?.['wp:featuredmedia']?.[0];
            const media = featuredMedia ? {
                id: featuredMedia.id,
                title: featuredMedia.title?.rendered,
                url: featuredMedia.source_url,
                alt: featuredMedia.alt_text,
                description: featuredMedia.description?.rendered,
                caption: featuredMedia.caption?.rendered,
                meta: {
                    width: featuredMedia.media_details?.width,
                    height: featuredMedia.media_details?.height,
                    sizes: featuredMedia.media_details?.sizes
                }
            } : null;

            return {
                id: page.id,
                title: page.title?.rendered,
                content: page.content?.rendered,
                excerpt: page.excerpt?.rendered,
                slug: page.slug,
                date: page.date,
                modified: page.modified,
                author,
                featuredMedia: media,
                parent: page.parent,
                menuOrder: page.menu_order,
                meta: {
                    ...page.meta,
                    yoast: page.yoast_head_json || {}
                },
                link: page.link,
                status: page.status,
                type: page.type,
                template: page.template
            };
        });

        res.json({
            count: enrichedPages.length,
            pages: enrichedPages
        });
    } catch (error) {
        console.error('Error fetching pages:', error);
        res.status(500).json({ 
            error: 'Failed to fetch pages',
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

app.get('/api/comments', async (req, res) => {
    try {
        console.log('Fetching comments...');
        const response = await axios.get(`${WORDPRESS_API_URL}/comments`, {
            params: {
                per_page: 100,
                orderby: 'date',
                order: 'desc'
            }
        });

        if (!Array.isArray(response.data)) {
            throw new Error('Expected an array of comments from WordPress API');
        }

        console.log(`Found ${response.data.length} comments`);

        const enrichedComments = response.data.map(comment => ({
            id: comment.id,
            post: comment.post,
            parent: comment.parent,
            author: {
                name: comment.author_name,
                url: comment.author_url,
                avatar: comment.author_avatar_urls
            },
            date: comment.date,
            content: comment.content?.rendered,
            status: comment.status,
            type: comment.type,
            link: comment.link,
            meta: comment.meta || {}
        }));

        res.json({
            count: enrichedComments.length,
            comments: enrichedComments
        });
    } catch (error) {
        console.error('Error fetching comments:', error);
        res.status(500).json({ 
            error: 'Failed to fetch comments',
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

app.get('/', (req, res) => {
    res.json({
        message: 'TiffyCooks Enhanced API',
        endpoints: {
            posts: '/api/posts',
            pages: '/api/pages',
            categories: '/api/categories',
            comments: '/api/comments'
        }
    });
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    
    // Start initial video processing
    if (process.env.NODE_ENV === 'production') {
        console.log('Starting initial video processing...');
        processPostsForVideos();
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Documentation endpoint
app.get('/api/docs', (req, res) => {
    res.json({
        version: '1.0.0',
        description: 'TiffyCooks Enhanced API',
        endpoints: {
            '/api/posts': {
                methods: ['GET'],
                parameters: {
                    per_page: 'number (optional)',
                    generate_video: 'boolean (optional)'
                },
                description: 'Fetch blog posts with enhanced media and recipe data'
            },
            '/api/categories': {
                methods: ['GET'],
                parameters: {},
                description: 'Fetch all categories with icons and metadata'
            },
            '/api/pages': {
                methods: ['GET'],
                parameters: {},
                description: 'Fetch static pages'
            },
            '/api/comments': {
                methods: ['GET'],
                parameters: {},
                description: 'Fetch post comments'
            }
        },
        authentication: {
            type: 'API Key',
            headerName: 'x-api-key'
        },
        rateLimiting: {
            windowMs: process.env.RATE_LIMIT_WINDOW_MS,
            maxRequests: process.env.RATE_LIMIT_MAX_REQUESTS
        }
    });
}); 