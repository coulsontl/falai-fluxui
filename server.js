const express = require('express');
const fal = require('@fal-ai/serverless-client');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const exifReader = require('exif-reader');
require('dotenv').config();
const multer = require('multer');  

const app = express();
app.use(express.json());
app.use(express.static('public'));

// 处理多个 FAL_KEY
const falKeys = process.env.FAL_KEY.split(',').map(key => key.trim());
let currentKeyIndex = 0;

// 获取下一个可用的 API Key
function getNextFalKey() {
  const key = falKeys[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % falKeys.length;
  return key;
}

// Configure fal.ai client with your API key
fal.config({
  credentials: getNextFalKey()
});

// Ensure the images directory exists
const imagesDir = path.join(__dirname, 'images');
fs.mkdir(imagesDir, { recursive: true });

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// 添加环境变量默认值
const OPENAI_API_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const PROMPT_TEMPLATE = process.env.PROMPT_TEMPLATE || 
  `作为 Stable Diffusion Prompt 提示词专家，您将从关键词中创建提示，通常来自 Danbooru 等数据库。\
提示通常描述图像，使用常见词汇，按重要性排列，并用逗号分隔。避免使用"-"或"."，但可以接受空格和自然语言。避免词汇重复。\
为了强调关键词，请将其放在括号中以增加其权重。例如，"(flowers)"将'flowers'的权重增加1.1倍，而"(((flowers)))"将其增加1.331倍。使用"(flowers:1.5)"将'flowers'的权重增加1.5倍。只为重要的标签增加权重。\
提示包括三个部分：**前缀**（质量标签+风格词+效果器）+ **主题**（图像的主要焦点）+ **场景**（背景、环境）。\
*   前缀影响图像质量。像"masterpiece"、"best quality"、"4k"这样的标签可以提高图像的细节。像"illustration"、"lensflare"这样的风格词定义图像的风格。像"bestlighting"、"lensflare"、"depthoffield"这样的效果器会影响光照和深度。\
*   主题是图像的主要焦点，如角色或场景。对主题进行详细描述可以确保图像丰富而详细。增加主题的权重以增强其清晰度。对于角色，描述面部、头发、身体、服装、姿势等特征。\
*   场景描述环境。没有场景，图像的背景是平淡的，主题显得过大。某些主题本身包含场景（例如建筑物、风景）。像"花草草地"、"阳光"、"河流"这样的环境词可以丰富场景。你的任务是设计图像生成的提示。请按照以下步骤进行操作：\
1.  我会发送给您一个图像场景。需要你生成详细的图像描述\
2.  图像描述必须是英文，输出为Positive Prompt。\
示例：\
我发送：二战时期的护士。\
您回复只回复：\
A WWII-era nurse in a German uniform, holding a wine bottle and stethoscope, sitting at a table in white attire, with a table in the background, masterpiece, best quality, 4k, illustration style, best lighting, depth of field, detailed character, detailed environment.\
`;

app.post('/generate-image', async (req, res) => {
  try {
    const { model, prompt, image_size, num_inference_steps, image_count } = req.body;

    console.log('Request payload:', req.body);

    // 验证并限制推理步数，根据模型要求
    let validatedSteps = parseInt(num_inference_steps);
    
    if (model === 'fal-ai/flux/schnell') {
      // schnell 模型的推理步数限制为12
      validatedSteps = Math.min(validatedSteps, 12);
    } else {
      // 对flux-pro模型，我们可以设置更高的限制
      validatedSteps = Math.min(validatedSteps, 50);
    }
    console.log(`Original steps: ${num_inference_steps}, Validated steps: ${validatedSteps}`);

    const input = {
      prompt,
      image_size,
      num_inference_steps: validatedSteps,
      num_images: parseInt(image_count) || 1
    };

    if (model === 'fal-ai/flux/dev') {
      input.guidance_scale = parseFloat(req.body.guidance_scale);
      input.enable_safety_checker = false;
    } else if (model === 'fal-ai/flux/schnell') {
      input.enable_safety_checker = false;
    } else {
      input.guidance_scale = parseFloat(req.body.guidance_scale);
      input.safety_tolerance = req.body.safety_tolerance;
    }

    // 配置下一个 API key
    fal.config({
      credentials: getNextFalKey()
    });
    console.log(`Using FAL_KEY index: ${currentKeyIndex === 0 ? falKeys.length - 1 : currentKeyIndex - 1}`);

    const result = await fal.subscribe(model, {
      input,
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS") {
          console.log(update.logs.map((log) => log.message));
        }
      },
    });


    const imageUrls = [];

    for (const image of result.images) {
      // Download and save the image
      const imageUrl = image.url;
      const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data, 'binary');

      const filename = `${uuidv4()}.jpg`;
      const filePath = path.join(imagesDir, filename);

      // Add metadata to the image
      const metadata = {
        model,
        prompt,
        image_size,
        num_inference_steps,
        ...(model === 'fal-ai/flux/dev' && { guidance_scale: input.guidance_scale }),
        ...(model === 'fal-ai/flux-pro' && { guidance_scale: input.guidance_scale, safety_tolerance: input.safety_tolerance }),
        seed: result.seed,
        timestamp: new Date().toISOString()
      };

      const metadataString = JSON.stringify(metadata);
      console.log('Saving metadata:', metadataString);

      await sharp(buffer)
        .withMetadata({
          exif: {
            IFD0: { ImageDescription: metadataString }
          }
        })
        .toFile(filePath);

      console.log('Image saved with metadata:', filePath);

      imageUrls.push(`/images/${filename}`);
    }

    res.json({ image_urls: imageUrls });
  } catch (error) {
    console.error('Error generating image:', error);
    if (error.body && error.body.detail) {
      console.error('Validation errors:', JSON.stringify(error.body.detail, null, 2));
    }
    res.status(500).json({ error: 'Error generating image', details: error.message, validationErrors: error.body?.detail });
  }
});

app.get('/gallery', async (req, res) => {
  try {
    const files = await fs.readdir(imagesDir);
    const images = await Promise.all(files
      .filter(file => file.endsWith('.jpg'))
      .map(async file => {
        const filePath = path.join(imagesDir, file);
        const stats = await fs.stat(filePath);
        return {
          filename: file,
          url: `/images/${file}`,
          created: stats.birthtime
        };
      }));
    
    images.sort((a, b) => b.created - a.created);
    res.json(images);
  } catch (error) {
    console.error('Error reading gallery:', error);
    res.status(500).json({ error: 'Error reading gallery', details: error.message });
  }
});

app.get('/image-metadata/:filename', async (req, res) => {
  const filePath = path.join(imagesDir, req.params.filename);
  console.log('Attempting to read metadata from:', filePath);

  try {
    const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
    if (!fileExists) {
      console.log('File not found:', filePath);
      return res.status(404).json({ error: 'Image not found' });
    }

    const metadata = await sharp(filePath).metadata();
    console.log('Sharp metadata:', metadata);

    if (metadata.exif) {
      console.log('EXIF data found, length:', metadata.exif.length);
      const exifData = exifReader(metadata.exif);
      console.log('Parsed EXIF data:', exifData);

      if (exifData.Image && exifData.Image.ImageDescription) {
        const imageDescription = exifData.Image.ImageDescription;
        console.log('Image description found:', imageDescription);
        try {
          const parsedMetadata = JSON.parse(imageDescription);
          res.json(parsedMetadata);
        } catch (parseError) {
          console.error('Error parsing image description:', parseError);
          res.status(500).json({ error: 'Error parsing image description', details: parseError.message });
        }
      } else {
        console.log('No ImageDescription found in EXIF data');
        res.status(404).json({ error: 'Metadata not found in EXIF' });
      }
    } else {
      console.log('No EXIF data found');
      res.status(404).json({ error: 'No EXIF data found' });
    }
  } catch (error) {
    console.error('Error reading metadata:', error);
    res.status(500).json({ error: 'Error reading metadata', details: error.message });
  }
});

app.post('/generate-img2img', upload.single('file'), async (req, res) => {
  try {
    const { prompt, strength, image_size, num_inference_steps, guidance_scale } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Upload the file to fal.ai storage
    const fileContent = await fs.readFile(file.path);
    
    // 配置下一个 API key
    fal.config({
      credentials: getNextFalKey()
    });
    console.log(`Using FAL_KEY index: ${currentKeyIndex === 0 ? falKeys.length - 1 : currentKeyIndex - 1}`);
    
    const uploadedFileUrl = await fal.storage.upload(fileContent);

    const input = {
      image_url: uploadedFileUrl,
      prompt,
      strength: parseFloat(strength),
      image_size,
      num_inference_steps: parseInt(num_inference_steps),
      guidance_scale: parseFloat(guidance_scale),
      enable_safety_checker: false
    };

    // 为 subscribe 操作重新配置 API key (以防上传和生成使用同一个 key 导致超出速率限制)
    fal.config({
      credentials: getNextFalKey()
    });
    console.log(`Using FAL_KEY index: ${currentKeyIndex === 0 ? falKeys.length - 1 : currentKeyIndex - 1}`);
    
    const result = await fal.subscribe("fal-ai/flux/dev/image-to-image", {
      input,
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS") {
          console.log(update.logs.map((log) => log.message));
        }
      },
    });

    const imageUrls = [];

    for (const image of result.images) {
      const imageUrl = image.url;
      const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data, 'binary');

      const filename = `${uuidv4()}.jpg`;
      const filePath = path.join(imagesDir, filename);

      const metadata = {
        prompt,
        strength,
        image_size,
        num_inference_steps,
        guidance_scale,
        seed: result.seed,
        timestamp: new Date().toISOString()
      };

      const metadataString = JSON.stringify(metadata);

      await sharp(buffer)
        .withMetadata({
          exif: {
            IFD0: { ImageDescription: metadataString }
          }
        })
        .toFile(filePath);

      imageUrls.push(`/images/${filename}`);
    }

    // Clean up the uploaded file
    await fs.unlink(file.path);

    res.json({ image_urls: imageUrls });
  } catch (error) {
    console.error('Error generating image:', error);
    res.status(500).json({ error: 'Error generating image', details: error.message });
  }
});

// 新增的优化提示词路由
app.post('/optimize-prompt', async (req, res) => {
  try {
    const { prompt, regenerate } = req.body;
    
    if (!OPENAI_API_KEY) {
      return res.status(400).json({ error: '未配置OpenAI API密钥。请在环境变量中设置OPENAI_API_KEY。' });
    }
    
    // 准备请求数据
    const promptMessage = PROMPT_TEMPLATE;
    
    // 调用OpenAI API
    const openaiResponse = await axios.post(`${OPENAI_API_URL}/chat/completions`, {
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: promptMessage },
        { role: 'user', content: prompt }
      ],
      temperature: regenerate ? 0.9 : 0.7, // 重新生成时使用更高的温度以增加多样性
    }, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    // 获取优化后的提示词
    const optimizedPrompt = openaiResponse.data.choices[0].message.content.trim();
    
    res.json({ optimizedPrompt });
  } catch (error) {
    console.error('优化提示词出错:', error);
    
    // 更详细的错误响应
    let errorMessage = '优化提示词时发生错误';
    let statusCode = 500;
    
    if (error.response) {
      statusCode = error.response.status;
      if (error.response.data && error.response.data.error) {
        errorMessage = `OpenAI API错误: ${error.response.data.error.message || error.response.data.error}`;
      }
    }
    
    res.status(statusCode).json({ error: errorMessage });
  }
});

app.use('/images', express.static(imagesDir));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});