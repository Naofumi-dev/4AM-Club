const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// CORS configuration - MUST be before other middleware
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    // List of allowed origins
    const allowedOrigins = [
      'https://4am-club.vercel.app',
      'https://4am-club-git-main-armagedddonvivas.vercel.app',
      'http://localhost:3000',
      'http://localhost:5173',
      /\.vercel\.app$/ // Allow all Vercel preview deployments
    ];
    
    const isAllowed = allowedOrigins.some(allowed => {
      if (allowed instanceof RegExp) {
        return allowed.test(origin);
      }
      return allowed === origin;
    });
    
    if (isAllowed) {
      callback(null, true);
    } else {
      console.log('Blocked origin:', origin);
      callback(null, true); // Still allow but log it
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-notion-api-key'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  maxAge: 86400 // 24 hours
};

// Apply CORS before any routes
app.use(cors(corsOptions));

// Handle preflight requests explicitly
app.options('*', cors(corsOptions));

// Body parser middleware
app.use(express.json());

// In-memory store for last sync state (in production, use Redis or database)
const syncState = {
  lastSyncTime: {},
  lastKnownData: {},
  clients: []
};

// WebSocket connections
const wsConnections = new Set();

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');
  wsConnections.add(ws);
  
  ws.on('close', () => {
    console.log('WebSocket connection closed');
    wsConnections.delete(ws);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    wsConnections.delete(ws);
  });
});

// Broadcast updates to all connected clients
function broadcastUpdate(data) {
  const message = JSON.stringify(data);
  wsConnections.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: '4AM Club Notion Sync Server',
    version: '2.0',
    websocket: `ws://${req.get('host')}`,
    activeConnections: wsConnections.size,
    endpoints: [
      'GET /api/notion/database/:databaseId - Test database connection',
      'POST /api/notion/query - Query database',
      'POST /api/notion/sync - Manual sync trigger',
      'GET /api/notion/changes/:databaseId - Get changes since last sync',
      'POST /api/notion/page - Create new page',
      'GET /api/sync/status - Get sync status',
      'WS / - WebSocket for real-time updates'
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

  console.log('Testing Notion connection:', { 
    databaseId: databaseId.substring(0, 8) + '...', 
    hasApiKey: !!apiKey 
  });

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
    res.json({
      success: true,
      database: {
        id: data.id,
        title: data.title?.[0]?.plain_text || 'Untitled',
        created_time: data.created_time,
        last_edited_time: data.last_edited_time,
        properties: Object.keys(data.properties || {})
      }
    });
  } catch (error) {
    console.error('Database fetch error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch database', 
      details: error.message 
    });
  }
});

// Query Notion database with change detection
app.post('/api/notion/query', async (req, res) => {
  const { databaseId, filter, sorts } = req.body;
  const apiKey = req.headers['x-notion-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing Notion API key in headers' });
  }

  if (!databaseId) {
    return res.status(400).json({ error: 'Missing databaseId in request body' });
  }

  try {
    // Build query with last_edited_time filter for efficiency
    const queryBody = {
      filter: filter || {},
      sorts: sorts || [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: 100
    };

    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(queryBody)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Query error:', response.status, data);
      return res.status(response.status).json({ 
        error: data.message || 'Query failed',
        code: data.code 
      });
    }

    // Parse and simplify results
    const results = data.results.map(page => parseNotionPage(page));

    // Detect changes
    const lastSync = syncState.lastSyncTime[databaseId];
    const changes = lastSync 
      ? results.filter(item => new Date(item.last_edited_time) > new Date(lastSync))
      : results;

    // Update sync state
    syncState.lastSyncTime[databaseId] = new Date().toISOString();
    syncState.lastKnownData[databaseId] = results;

    // Broadcast changes via WebSocket if any
    if (changes.length > 0) {
      broadcastUpdate({
        type: 'notion_update',
        databaseId,
        changes: changes.length,
        data: changes
      });
    }

    res.json({
      success: true,
      results,
      changes,
      has_more: data.has_more,
      next_cursor: data.next_cursor,
      total_count: results.length,
      changes_count: changes.length,
      last_sync: lastSync
    });

  } catch (error) {
    console.error('Query error:', error);
    res.status(500).json({ 
      error: 'Failed to query database', 
      details: error.message 
    });
  }
});

// Get only changes since last sync (efficient endpoint)
app.get('/api/notion/changes/:databaseId', async (req, res) => {
  const { databaseId } = req.params;
  const apiKey = req.headers['x-notion-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing Notion API key in headers' });
  }

  try {
    const lastSync = syncState.lastSyncTime[databaseId];
    
    // Build filter to only get items edited after last sync
    const filter = lastSync ? {
      timestamp: 'last_edited_time',
      last_edited_time: {
        after: lastSync
      }
    } : {};

    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        filter,
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: data.message || 'Failed to fetch changes',
        code: data.code 
      });
    }

    const changes = data.results.map(page => parseNotionPage(page));

    // Update sync time
    if (changes.length > 0) {
      syncState.lastSyncTime[databaseId] = new Date().toISOString();
      
      // Broadcast changes
      broadcastUpdate({
        type: 'notion_changes',
        databaseId,
        changes: changes.length,
        data: changes
      });
    }

    res.json({
      success: true,
      changes,
      changes_count: changes.length,
      last_sync: lastSync,
      current_time: new Date().toISOString()
    });

  } catch (error) {
    console.error('Changes fetch error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch changes', 
      details: error.message 
    });
  }
});

// Manual sync trigger
app.post('/api/notion/sync', async (req, res) => {
  const { databaseId } = req.body;
  const apiKey = req.headers['x-notion-api-key'];

  if (!apiKey || !databaseId) {
    return res.status(400).json({ error: 'Missing API key or database ID' });
  }

  try {
    // Trigger sync via the query endpoint
    const response = await fetch(`http://localhost:${PORT}/api/notion/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-notion-api-key': apiKey
      },
      body: JSON.stringify({ databaseId })
    });

    const data = await response.json();
    
    res.json({
      success: true,
      message: 'Sync completed',
      ...data
    });

  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({ 
      error: 'Sync failed', 
      details: error.message 
    });
  }
});

// Get sync status
app.get('/api/sync/status', (req, res) => {
  res.json({
    success: true,
    databases: Object.keys(syncState.lastSyncTime).map(dbId => ({
      databaseId: dbId,
      lastSync: syncState.lastSyncTime[dbId],
      recordCount: syncState.lastKnownData[dbId]?.length || 0
    })),
    activeWebSocketConnections: wsConnections.size,
    uptime: process.uptime()
  });
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

    res.json({
      success: true,
      page: parseNotionPage(data)
    });
  } catch (error) {
    console.error('Create page error:', error);
    res.status(500).json({ 
      error: 'Failed to create page', 
      details: error.message 
    });
  }
});

// Helper function to parse Notion page data
function parseNotionPage(page) {
  const properties = {};
  
  // Extract all property types
  for (const [key, value] of Object.entries(page.properties || {})) {
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
      } else if (value.files && value.files.length > 0) {
        properties[key] = value.files[0].name;
      } else if (value.created_time) {
        properties[key] = value.created_time;
      } else if (value.last_edited_time) {
        properties[key] = value.last_edited_time;
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
    archived: page.archived || false,
    properties
  };
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error', 
    details: err.message 
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 4AM Club Notion Sync Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for connections`);
  console.log(`🔗 API: http://localhost:${PORT}`);
  console.log(`🔗 WebSocket: ws://localhost:${PORT}`);
});

// Auto-sync polling (optional - can be enabled via environment variable)
if (process.env.ENABLE_AUTO_SYNC === 'true') {
  const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL || '300000'); // 5 minutes default
  
  setInterval(async () => {
    console.log('🔄 Running auto-sync...');
    
    // Sync all known databases
    for (const dbId of Object.keys(syncState.lastSyncTime)) {
      try {
        const apiKey = process.env.NOTION_API_KEY;
        if (!apiKey) continue;
        
        const response = await fetch(`http://localhost:${PORT}/api/notion/changes/${dbId}`, {
          headers: { 'x-notion-api-key': apiKey }
        });
        
        if (response.ok) {
          const data = await response.json();
          console.log(`✅ Synced ${dbId}: ${data.changes_count} changes`);
        }
      } catch (error) {
        console.error(`❌ Auto-sync failed for ${dbId}:`, error.message);
      }
    }
  }, SYNC_INTERVAL);
  
  console.log(`⏰ Auto-sync enabled (every ${SYNC_INTERVAL / 1000}s)`);
}

module.exports = app;
