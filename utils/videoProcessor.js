const { google } = require('googleapis');
const { put } = require('@vercel/blob');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const youtube = google.youtube('v3');

// Initialize the YouTube API client
const youtubeClient = youtube.videos;

// Create temp directory if it doesn't exist
const tempDir = path.join(process.cwd(), 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

// Helper function to download image
async function downloadImage(url, filepath) {
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });
    
    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(filepath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// Helper function to create a video from an image
function createVideoFromImage(inputPath, outputPath, duration = 3) {
    return new Promise((resolve, reject) => {
        // Complex filter to create TikTok-style video with blurred background
        const filter = [
            // Split the input into two streams
            '[0:v]split[original][blur]',
            // Create blurred background
            '[blur]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[blurred]',
            // Scale original image to fit within 1080x1920 while maintaining aspect ratio
            '[original]scale=1080:1920:force_original_aspect_ratio=decrease[scaled]',
            // Overlay the original image on top of the blurred background
            '[blurred][scaled]overlay=(W-w)/2:(H-h)/2[final]'
        ].join(';');

        ffmpeg()
            .input(inputPath)
            .loop(duration)
            .outputOptions([
                '-c:v libx264',
                '-t ' + duration,
                '-pix_fmt yuv420p',
                '-preset ultrafast',
                '-r 30'  // Set framerate to 30fps
            ])
            .complexFilter(filter, 'final')
            .save(outputPath)
            .on('end', () => {
                // Verify the duration of the created clip
                ffmpeg.ffprobe(outputPath, (err, metadata) => {
                    if (err) {
                        console.error('Error verifying clip duration:', err);
                        reject(err);
                        return;
                    }
                    const actualDuration = metadata.format.duration;
                    console.log(`Clip duration: ${actualDuration}s (expected: ${duration}s)`);
                    resolve();
                });
            })
            .on('error', (err) => {
                console.error('FFmpeg error in createVideoFromImage:', err);
                reject(err);
            });
    });
}

// Helper function to concatenate videos in batches
async function concatenateVideosInBatches(inputPaths, outputPath, batchSize = 5) {
    if (inputPaths.length <= batchSize) {
        return concatenateVideos(inputPaths, outputPath);
    }

    // Process videos in batches
    const batches = [];
    for (let i = 0; i < inputPaths.length; i += batchSize) {
        const batch = inputPaths.slice(i, i + batchSize);
        const batchOutputPath = path.join(path.dirname(outputPath), `batch_${i/batchSize}.mp4`);
        await concatenateVideos(batch, batchOutputPath);
        batches.push(batchOutputPath);
    }

    // Final concatenation of batches
    const command = ffmpeg();
    
    // Create a concat file
    const concatFilePath = path.join(path.dirname(outputPath), 'concat.txt');
    const concatContent = batches.map(file => `file '${file}'`).join('\n');
    fs.writeFileSync(concatFilePath, concatContent);

    return new Promise((resolve, reject) => {
        command
            .input(concatFilePath)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions([
                '-c copy',
                '-movflags +faststart'
            ])
            .save(outputPath)
            .on('end', () => {
                // Clean up batch files
                batches.forEach(file => fs.unlinkSync(file));
                fs.unlinkSync(concatFilePath);
                resolve();
            })
            .on('error', reject);
    });
}

// Helper function to concatenate videos
function concatenateVideos(inputPaths, outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`Concatenating ${inputPaths.length} video clips`);
        
        // Create a concat file
        const concatFilePath = path.join(path.dirname(outputPath), 'concat.txt');
        const concatContent = inputPaths.map(file => `file '${file}'`).join('\n');
        fs.writeFileSync(concatFilePath, concatContent);

        console.log('Created concat file with content:', concatContent);

        const command = ffmpeg();
        
        command
            .input(concatFilePath)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions([
                '-c:v libx264',
                '-preset ultrafast',
                '-pix_fmt yuv420p',
                '-movflags +faststart',
                '-r 30'  // Maintain 30fps
            ])
            .on('start', (commandLine) => {
                console.log('FFmpeg command:', commandLine);
            })
            .on('progress', (progress) => {
                console.log('Processing: ', progress.percent, '% done');
            })
            .on('end', () => {
                // Verify final video duration
                ffmpeg.ffprobe(outputPath, (err, metadata) => {
                    if (err) {
                        console.error('Error verifying final video duration:', err);
                        reject(err);
                        return;
                    }
                    const actualDuration = metadata.format.duration;
                    const expectedDuration = inputPaths.length * 3;
                    console.log(`Final video duration: ${actualDuration}s (expected: ${expectedDuration}s)`);
                    
                    // Clean up concat file
                    fs.unlinkSync(concatFilePath);
                    resolve();
                });
            })
            .on('error', (err) => {
                console.error('FFmpeg error:', err);
                // Clean up concat file even on error
                if (fs.existsSync(concatFilePath)) {
                    fs.unlinkSync(concatFilePath);
                }
                reject(err);
            })
            .save(outputPath);
    });
}

// Main video generation function
async function generateVideoFromImages(images, postTitle) {
    try {
        const timestamp = Date.now();
        const workingDir = path.join(tempDir, `video_${timestamp}`);
        
        if (!fs.existsSync(workingDir)) {
            fs.mkdirSync(workingDir);
        }

        console.log(`Generating video for post: "${postTitle}"`);
        console.log(`Processing ${images.length} images`);

        // Filter out duplicate images and small thumbnails
        const uniqueImages = images.filter((img, index, self) => {
            // Fix the duplicate check - keep first occurrence of each unique URL
            const isDuplicate = index === self.findIndex(i => i.url === img.url);
            const isLargeEnough = (!img.width || img.width > 300) && (!img.height || img.height > 300);
            // Improve URL validation to better identify full-size images
            const isValidUrl = img.url && 
                !img.url.includes('150x150') && 
                !img.url.includes('300x') && 
                !img.url.includes('-150x') && 
                !img.url.includes('-300x') &&
                !img.url.includes('-thumbnail');
            
            // Log each image's filtering decision
            console.log(`Image ${index + 1} filtering:`, {
                url: img.url,
                isUnique: isDuplicate,
                isLargeEnough,
                isValidUrl,
                width: img.width,
                height: img.height,
                willKeep: isDuplicate && isLargeEnough && isValidUrl
            });
            
            return isDuplicate && isLargeEnough && isValidUrl;
        });

        console.log(`Processing ${uniqueImages.length} unique images after filtering`);
        
        if (uniqueImages.length === 0) {
            throw new Error('No valid images found after filtering');
        }

        // Sort images by filename to maintain chronological order
        uniqueImages.sort((a, b) => {
            const aName = a.url.split('/').pop();
            const bName = b.url.split('/').pop();
            return aName.localeCompare(bName);
        });

        // Log final selected images
        console.log('Final selected images:');
        uniqueImages.forEach((img, index) => {
            console.log(`${index + 1}. ${img.url}`);
        });

        // Download all images
        const imageFiles = await Promise.all(uniqueImages.map(async (image, index) => {
            const ext = path.extname(image.url) || '.jpg';
            const filepath = path.join(workingDir, `image_${index}${ext}`);
            console.log(`Downloading image ${index + 1}:`, image.url);
            await downloadImage(image.url, filepath);
            return filepath;
        }));

        console.log('Images downloaded successfully');

        // Create individual video clips for each image
        const videoClips = await Promise.all(imageFiles.map(async (imagePath, index) => {
            const outputPath = path.join(workingDir, `clip_${index}.mp4`);
            console.log(`Creating video clip ${index + 1} from ${imagePath}`);
            await createVideoFromImage(imagePath, outputPath);
            return outputPath;
        }));

        console.log('Individual video clips created');

        // Concatenate all clips with transitions
        const finalVideoPath = path.join(workingDir, 'final.mp4');
        await concatenateVideos(videoClips, finalVideoPath);

        console.log('Video concatenation complete');

        // Upload to Vercel Blob
        console.log('Reading final video file');
        const videoBuffer = fs.readFileSync(finalVideoPath);
        
        const sanitizedTitle = postTitle
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
            
        const filename = `${sanitizedTitle}-${timestamp}.mp4`;
        console.log('Uploading to Vercel Blob as:', filename);
        
        const blobUrl = await uploadToVercelBlob(videoBuffer, filename);

        console.log('Video uploaded to Vercel Blob:', blobUrl);

        // Clean up temporary files
        fs.rmSync(workingDir, { recursive: true, force: true });

        return {
            status: 'completed',
            url: blobUrl,
            meta: {
                duration: videoClips.length * 3, // 3 seconds per image
                imageCount: uniqueImages.length,
                format: '1080x1920',
                timestamp
            }
        };
    } catch (error) {
        console.error('Error generating video:', error);
        return {
            status: 'error',
            error: error.message,
            meta: {
                imageCount: images.length,
                timestamp: Date.now()
            }
        };
    }
}

async function extractYoutubeVideoId(url) {
    let videoId = null;
    
    // Handle different YouTube URL formats
    if (url.includes('youtube.com/watch')) {
        const urlParams = new URL(url).searchParams;
        videoId = urlParams.get('v');
    } else if (url.includes('youtu.be/')) {
        videoId = url.split('youtu.be/')[1].split('?')[0];
    } else if (url.includes('youtube.com/embed/')) {
        videoId = url.split('youtube.com/embed/')[1].split('?')[0];
    }

    return videoId;
}

async function getEnhancedYoutubeData(videoId) {
    try {
        const response = await youtubeClient.list({
            key: process.env.YOUTUBE_API_KEY,
            part: ['snippet', 'contentDetails', 'statistics', 'player'],
            id: [videoId]
        });

        if (!response.data.items || response.data.items.length === 0) {
            throw new Error('Video not found');
        }

        const video = response.data.items[0];
        
        // Get different quality thumbnails
        const thumbnails = video.snippet.thumbnails;
        
        return {
            id: videoId,
            type: 'youtube',
            title: video.snippet.title,
            description: video.snippet.description,
            publishedAt: video.snippet.publishedAt,
            thumbnails: {
                default: thumbnails.default?.url,
                medium: thumbnails.medium?.url,
                high: thumbnails.high?.url,
                standard: thumbnails.standard?.url,
                maxres: thumbnails.maxres?.url,
            },
            statistics: {
                viewCount: video.statistics.viewCount,
                likeCount: video.statistics.likeCount,
                commentCount: video.statistics.commentCount
            },
            duration: video.contentDetails.duration,
            embedHtml: video.player.embedHtml,
            directUrls: {
                embed: `https://www.youtube.com/embed/${videoId}`,
                watch: `https://www.youtube.com/watch?v=${videoId}`,
                share: `https://youtu.be/${videoId}`
            }
        };
    } catch (error) {
        console.error('Error fetching YouTube data:', error);
        return null;
    }
}

async function uploadToVercelBlob(buffer, filename) {
    try {
        const blob = await put(filename, buffer, {
            access: 'public',
            addRandomSuffix: true
        });
        
        return blob.url;
    } catch (error) {
        console.error('Error uploading to Vercel Blob:', error);
        return null;
    }
}

module.exports = {
    extractYoutubeVideoId,
    getEnhancedYoutubeData,
    generateVideoFromImages,
    uploadToVercelBlob
}; 