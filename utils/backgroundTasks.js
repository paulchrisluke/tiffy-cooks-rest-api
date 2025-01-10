const cron = require('node-cron');
const axios = require('axios');
const { generateVideoFromImages } = require('./videoProcessor');
const { put } = require('@vercel/blob');

const WORDPRESS_API_URL = 'https://tiffycooks.com/wp-json/wp/v2';
let isProcessing = false;

// Keep track of processed posts
const processedPosts = new Set();

async function fetchAllPosts(page = 1, allPosts = []) {
    try {
        const response = await axios.get(`${WORDPRESS_API_URL}/posts`, {
            params: {
                _embed: true,
                per_page: 100,
                page,
                orderby: 'date',
                order: 'desc'
            }
        });

        const posts = response.data;
        allPosts.push(...posts);

        // Check if there are more pages
        const totalPages = parseInt(response.headers['x-wp-totalpages']);
        if (page < totalPages) {
            return fetchAllPosts(page + 1, allPosts);
        }

        return allPosts;
    } catch (error) {
        if (error.response?.status === 400) {
            // No more pages
            return allPosts;
        }
        throw error;
    }
}

async function extractImagesFromPost(post) {
    const tempDiv = new (require('jsdom').JSDOM)(`<!DOCTYPE html><div>${post.content.rendered}</div>`).window.document.querySelector('div');
    
    return Array.from(tempDiv.querySelectorAll('img')).map(img => ({
        url: img.src,
        alt: img.alt || '',
        title: img.title || '',
        width: img.width || null,
        height: img.height || null,
        caption: img.getAttribute('data-caption') || ''
    }));
}

async function generateAndStoreVideo(post) {
    try {
        // Check if we've already processed this post
        if (processedPosts.has(post.id)) {
            console.log(`Post ${post.id} already processed, skipping...`);
            return;
        }

        console.log(`Processing video for post: ${post.title.rendered}`);
        const images = await extractImagesFromPost(post);
        
        if (images.length === 0) {
            console.log('No images found in post, skipping video generation');
            return;
        }

        const videoResult = await generateVideoFromImages(images, post.title.rendered);
        if (videoResult) {
            console.log(`Successfully generated video for post: ${post.title.rendered}`);
            processedPosts.add(post.id);
        }
    } catch (error) {
        console.error(`Error generating video for post ${post.id}:`, error);
    }
}

async function processPostsForVideos() {
    if (isProcessing) {
        console.log('Already processing posts, skipping...');
        return;
    }

    try {
        isProcessing = true;
        console.log('Starting video generation for posts...');
        
        const posts = await fetchAllPosts();
        console.log(`Found ${posts.length} posts to process`);

        // Process posts one at a time to avoid overwhelming the system
        for (const post of posts) {
            await generateAndStoreVideo(post);
            // Add a delay between posts to prevent rate limiting
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        console.log('Finished processing all posts');
    } catch (error) {
        console.error('Error processing posts:', error);
    } finally {
        isProcessing = false;
    }
}

// Schedule video generation task - run every 4 hours
// This will process posts that don't have videos yet
cron.schedule('0 */4 * * *', () => {
    console.log('Running scheduled video generation task...');
    processPostsForVideos();
});

// Schedule content sync task - run every 24 hours
cron.schedule('0 0 * * *', async () => {
    console.log('Running daily content sync...');
    try {
        // Clear the processed posts set to allow re-processing of updated content
        processedPosts.clear();
        
        // The actual sync happens through the API endpoints
        // This will trigger a fresh fetch of content when the next request comes in
        console.log('Content sync completed');
    } catch (error) {
        console.error('Error during content sync:', error);
    }
});

// Export for use in index.js
module.exports = {
    processPostsForVideos,
    processedPosts
}; 