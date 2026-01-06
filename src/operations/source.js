import { z } from 'zod';
import { readFileSync } from 'fs';
import { daAdminRequest, daAdminResponseFormat, formatURL } from '../common/utils.js';

/**
 * Retry wrapper with exponential backoff (from chatbotv1.js)
 * Handles SSL/TLS errors, connection resets, and other transient failures
 */
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Check if it's a retryable error
      const isRetryable = 
        error.message.includes('Failed to fetch') ||
        error.message.includes('SSL') ||
        error.message.includes('TLS') ||
        error.message.includes('Network') ||
        error.message.includes('ECONNRESET');
      
      // If not retryable or last attempt, throw
      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }
      
      // Calculate exponential backoff delay
      const delay = initialDelay * Math.pow(2, attempt);
      console.error(`⚠️ Attempt ${attempt + 1} failed (${error.message}). Retrying in ${delay}ms...`);
      
      await new Promise(r => setTimeout(r, delay));
    }
  }
  
  throw lastError;
}

const GetSourceSchema = z.object({
  org: z.string().describe('The organization'),
  repo: z.string().describe('Name of the repository'),
  path: z.string().describe('Path to the source content (with or without extension)'),
  ext: z.string().describe('The source content file extension: html or json'),
});

const CreateSourceSchema = z.object({
  org: z.string().describe('The organization'),
  repo: z.string().describe('Name of the repository'),
  path: z.string().describe('Path to the source content'),
  ext: z.string().describe('The source content file extension: html or json'),
  content: z.string().describe(`
    If extension is html: an html string using the following template: "<body><header></header><main><!-- content here --></main><footer></footer></body>". Only <main> should be populated with content.
    If extension is json: a json string representing a spreadsheet which can have multiple sheets. Each sheet can have an array of rows (represented as a data property). Each row can have as many cells as needed. A cell is a key / value pair. Simple sample: 
    {
      "sheet1": {
        "total": 2,
        "data": [{
          "column1": "value11",
          "column2": "value12",
          "column3": "value13"
        },
        {
          "column1": "value21",
          "column2": "value22",
          "column3": "value23"
        }],
      },
      ":names": [
        "sheet1"
      ],
      ":type": "multi-sheet"
    }
  `),
});

const UploadAssetSchema = z.object({
  org: z.string().describe('The organization'),
  repo: z.string().describe('Name of the repository'),
  path: z.string().describe('Path where the asset should be uploaded (e.g., assets/images/photo.png)'),
  localFilePath: z.string().describe('Local file system path to the asset file (e.g., ./dam/image.png)'),
  contentType: z.string().optional().describe('MIME type of the file (e.g., image/png, image/jpeg). Auto-detected if not provided.'),
});

const DeleteSourceSchema = z.object({
  org: z.string().describe('The organization'),
  repo: z.string().describe('Name of the repository'),
  path: z.string().describe('Path to the source content'),
  ext: z.string().describe('The source content file extension: html or json'),
});

async function getSource(org, repo, path, ext) {
  try {
    const url = formatURL('source', org, repo, path, ext);
    const data = await daAdminRequest(url);
    return daAdminResponseFormat(data);
  } catch (error) {
    console.error(error);
    throw error;
  }
}

async function createSource(org, repo, path, ext, content) {
  try {
    const url = formatURL('source', org, repo, path, ext);
    const body = new FormData();
    const type = ext === 'html' ? 'text/html' : 'application/json';
    const blob = new Blob([content], { type });
    body.set('data', blob);
    
    const data = await daAdminRequest(url, {
      method: 'POST',
      body,
    });
    return daAdminResponseFormat(data);
  } catch (error) {
    console.error(error);
    throw error;
  }
}

async function deleteSource(org, repo, path, ext) {
  try {
    const url = formatURL('source', org, repo, path, ext);
    const data = await daAdminRequest(url, {
      method: 'DELETE'
    });
    return daAdminResponseFormat(data);
  } catch (error) {
    console.error(error);
    throw error;
  }
}

/**
 * Upload binary asset (images, PDFs, etc.) to DA
 * Exactly mirrors the workflow from chatbotv1.js uploadImageToDA function
 * Reads from local file system and uploads to DA with EDS preview/publish
 */
async function uploadAsset(org, repo, path, localFilePath, contentType) {
  console.error(`📤 Uploading asset to DA: ${path}`);
  
  try {
    // Step 1: Read the file from local filesystem
    console.error(`Reading file: ${localFilePath}`);
    const fileBuffer = readFileSync(localFilePath);
    console.error(`✅ File read (${fileBuffer.length} bytes)`);
    
    // Auto-detect content type if not provided
    let mimeType = contentType;
    if (!mimeType) {
      const ext = localFilePath.split('.').pop().toLowerCase();
      const mimeTypes = {
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
        'pdf': 'application/pdf',
        'mp4': 'video/mp4',
        'webm': 'video/webm'
      };
      mimeType = mimeTypes[ext] || 'application/octet-stream';
    }
    
    // Step 2: Upload to DA (WITH RETRY - same as chatbotv1.js)
    const uploadUrl = `https://admin.da.live/source/${org}/${repo}/${path}`;
    console.error(`Uploading to DA: ${uploadUrl}`);
    
    await retryWithBackoff(async () => {
      const formData = new FormData();
      const blob = new Blob([fileBuffer], { type: mimeType });
      const filename = path.split('/').pop();
      formData.append('data', blob, filename);
      
      const uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.DA_ADMIN_API_TOKEN}`
        },
        body: formData
      });
      
      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        console.error('DA upload failed:', uploadResponse.status, errorText);
        throw new Error(`DA upload failed: ${uploadResponse.status}`);
      }
      
      console.error(`✅ Asset uploaded to DA at: ${path}`);
    }, 3, 1000); // 3 retries, starting with 1s delay
    
    // Step 3: EDS Preview (WITH RETRY)
    const previewUrl = `https://admin.hlx.page/preview/${org}/${repo}/main/${path}`;
    console.error(`Triggering EDS preview: ${previewUrl}`);
    
    await retryWithBackoff(async () => {
      const previewResponse = await fetch(previewUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.DA_ADMIN_API_TOKEN}`
        }
      });
      
      if (!previewResponse.ok) {
        console.error('Preview trigger failed:', previewResponse.status);
        // Don't throw - preview is optional
      } else {
        console.error(`✅ EDS preview triggered`);
      }
    }, 2, 500); // 2 retries, starting with 500ms delay
    
    // Wait for preview to process
    await new Promise(r => setTimeout(r, 1000));
    
    // Step 4: EDS Publish (WITH RETRY)
    const publishUrl = `https://admin.hlx.page/live/${org}/${repo}/main/${path}`;
    console.error(`Publishing to EDS: ${publishUrl}`);
    
    await retryWithBackoff(async () => {
      const publishResponse = await fetch(publishUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.DA_ADMIN_API_TOKEN}`
        }
      });
      
      if (!publishResponse.ok) {
        console.error('Publish trigger failed:', publishResponse.status);
        // Don't throw - we can still return the URL
      } else {
        console.error(`✅ EDS publish triggered`);
      }
    }, 2, 500); // 2 retries, starting with 500ms delay
    
    // Wait for publish to complete
    await new Promise(r => setTimeout(r, 800));
    
    // Step 5: Return the EDS URLs (same as chatbotv1.js)
    const edsUrl = `https://main--${repo}--${org}.aem.page/${path}`;
    const liveUrl = `https://main--${repo}--${org}.aem.live/${path}`;
    
    console.error(`✅ Asset available at: ${edsUrl}`);
    
    return {
      success: true,
      path: path,
      previewUrl: edsUrl,
      liveUrl: liveUrl,
      contentType: mimeType,
      size: fileBuffer.length
    };
    
  } catch (error) {
    console.error('Asset upload/publish failed:', error);
    console.error('Error details:', {
      name: error.name,
      message: error.message
    });
    
    // Provide more specific error messages (same as chatbotv1.js)
    if (error.message.includes('Failed to fetch') || error.message.includes('SSL') || error.message.includes('TLS')) {
      throw new Error(`Network error uploading to DA after multiple retries. This could be:\n- SSL/TLS issue (ERR_SSL_BAD_RECORD_MAC_ALERT)\n- Network connectivity problem\n- DA API rate limiting\n- Server connection limit\nOriginal error: ${error.message}\n\nTry again in a few moments.`);
    }
    
    throw new Error(`Failed to upload asset to DA: ${error.message}`);
  }
} 

export const tools = [{
  name: "da_admin_get_source",
  description: "Get source content from an organization: can be an html file or a json file",
  schema: GetSourceSchema,
  handler: async (args) => {
    return getSource(args.org, args.repo, args.path, args.ext);
  }
}, {
  name: "da_admin_create_source",
  description: "Create source content within an organization: can be an html file or a json file",
  schema: CreateSourceSchema,
  handler: async (args) => {
    return createSource(args.org, args.repo, args.path, args.ext, args.content);
  }
}, {
  name: "da_admin_delete_source",
  description: "Delete source content from an organization: can be an html file or a json file",
  schema: DeleteSourceSchema,
  handler: async (args) => {
    return deleteSource(args.org, args.repo, args.path, args.ext);
  }
}, {
  name: "da_admin_upload_asset",
  description: "Upload binary asset (image, video, PDF, etc.) to DA from local filesystem. Automatically triggers EDS preview and publish.",
  schema: UploadAssetSchema,
  handler: async (args) => {
    return uploadAsset(args.org, args.repo, args.path, args.localFilePath, args.contentType);
  }
}];