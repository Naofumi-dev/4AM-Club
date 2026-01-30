const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: '4AM Club Notion Proxy Server',
    endpoints: [
      'GET /api/notion/database/:databaseId',
      'POST /api/notion/query',
      'POST /api/notion/page'
    ]
  });
});

// Test Notion connection
app.get('/api/notion/database/:databaseId', async (req, res) => {
  const { databaseId } = req.params;
  const apiKey = req.headers['x-notion-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing Notion API key in headers' });
  }

  console.log('Testing Notion connection:', { databaseId: databaseId.substring(0, 8) + '...', hasApiKey: !!apiKey });

  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Notion API error:', response.status, data);
      return res.status(response.status).json({ 
        error: data.message || data.error || 'Notion API error',
        code: data.code,
        details: data
      });
    }

    console.log('Notion connection successful');
    res.json(data);
  } catch (error) {
    console.error('Database fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch database', details: error.message });
  }
});

// Query Notion database
app.post('/api/notion/query', async (req, res) => {
  const { databaseId } = req.body;
  const apiKey = req.headers['x-notion-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing Notion API key in headers' });
  }

  if (!databaseId) {
    return res.status(400).json({ error: 'Missing databaseId in request body' });
  }

  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body.filter || {})
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // Parse and return simplified data with better property extraction
    const results = data.results.map(page => {
      const properties = {};
      
      // Extract properties with better handling
      for (const [key, value] of Object.entries(page.properties)) {
        try {
          if (value.title && value.title.length > 0) {
            properties[key] = value.title[0].plain_text;
          } else if (value.rich_text && value.rich_text.length > 0) {
            properties[key] = value.rich_text[0].plain_text;
          } else if (value.select) {
            properties[key] = value.select.name;
          } else if (value.multi_select && value.multi_select.length > 0) {
            properties[key] = value.multi_select.map(s => s.name).join(', ');
          } else if (value.date) {
            properties[key] = value.date.start;
          } else if (value.number !== null && value.number !== undefined) {
            properties[key] = value.number;
          } else if (value.email) {
            properties[key] = value.email;
          } else if (value.url) {
            properties[key] = value.url;
          } else if (value.phone_number) {
            properties[key] = value.phone_number;
          } else if (value.checkbox !== null && value.checkbox !== undefined) {
            properties[key] = value.checkbox;
          } else if (value.people && value.people.length > 0) {
            properties[key] = value.people.map(p => p.name || p.email).join(', ');
          } else if (value.status) {
            properties[key] = value.status.name;
          }
        } catch (err) {
          console.error(`Error extracting property ${key}:`, err);
          properties[key] = null;
        }
      }

      return {
        id: page.id,
        created_time: page.created_time,
        last_edited_time: page.last_edited_time,
        url: page.url,
        properties
      };
    });

    res.json({
      results,
      has_more: data.has_more,
      next_cursor: data.next_cursor,
      total_count: results.length
    });
  } catch (error) {
    console.error('Query error:', error);
    res.status(500).json({ error: 'Failed to query database', details: error.message });
  }
});

// Create new page in Notion
app.post('/api/notion/page', async (req, res) => {
  const { databaseId, properties } = req.body;
  const apiKey = req.headers['x-notion-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing Notion API key in headers' });
  }

  if (!databaseId || !properties) {
    return res.status(400).json({ error: 'Missing databaseId or properties in request body' });
  }

  try {
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties: properties
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    console.error('Create page error:', error);
    res.status(500).json({ error: 'Failed to create page', details: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

app.listen(PORT, () => {
  console.log(`🚀 4AM Club Notion Proxy running on port ${PORT}`);
});

module.exports = app;
