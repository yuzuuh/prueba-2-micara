'use strict';
require('dotenv').config();
const express     = require('express');
const bodyParser  = require('body-parser');
const cors        = require('cors');
const helmet      = require('helmet');
const { MongoClient } = require('mongodb');

const apiRoutes         = require('./routes/api.js');
const fccTestingRoutes  = require('./routes/fcctesting.js');
const runner            = require('./test-runner');

const app = express();

// Configuraciones de seguridad con helmet
app.use(helmet({
  // Solo permitir que el sitio se cargue en un iFrame en sus propias páginas
  frameguard: { action: 'sameorigin' },

  // No permitir la precarga de DNS
  dnsPrefetchControl: { allow: false },

  // Permitir que el sitio envíe el referente únicamente a sus propias páginas
  referrerPolicy: { policy: 'same-origin' },

  // Otras configuraciones de seguridad
  contentSecurityPolicy: false // Deshabilitado para FCC testing
}));

app.use('/public', express.static(process.cwd() + '/public'));

// CORS configurado para FCC testing - permite todos los orígenes
app.use(cors({ origin: '*' }));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Middleware para agregar headers de no-cache para evitar problemas de cache
app.use((req, res, next) => {
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.header('Pragma', 'no-cache');
  res.header('Expires', '0');
  next();
});

// Sample front-end routes
app.route('/b/:board/')
  .get(function (req, res) {
    res.sendFile(process.cwd() + '/views/board.html');
  });

app.route('/b/:board/:threadid')
  .get(function (req, res) {
    res.sendFile(process.cwd() + '/views/thread.html');
  });

// Index page (static HTML)
app.route('/')
  .get(function (req, res) {
    res.sendFile(process.cwd() + '/views/index.html');
  });

// For FCC testing purposes
fccTestingRoutes(app);

// Configuración de conexión a base de datos
const MONGO_URI = process.env.DB || process.env.MONGO_URI || 'mongodb://localhost:27017/anonymous_messageboard';
const PORT = process.env.PORT || 5000;

// Función para crear una colección en memoria si no hay MongoDB disponible
function createMemoryStorage() {
  const threads = [];

  const memoryDB = {
    collection: function(name) {
      return {
        insertOne: async (doc) => {
          if (!doc._id) {
            const timestamp = Math.floor(new Date().getTime() / 1000).toString(16);
            const randomHex = Math.random().toString(16).substr(2, 16);
            const objectIdString = (timestamp + randomHex).padEnd(24, '0').substr(0, 24);
            doc._id = { toString: () => objectIdString };
          }
          threads.push({ ...doc });
          return { insertedId: doc._id };
        },

        find: (query = {}, options = {}) => ({
          sort: (sortOptions) => ({
            limit: (limitNum) => ({
              toArray: async () => {
                let filtered = threads.filter(t => {
                  if (query.board && t.board !== query.board) return false;
                  return true;
                });

                if (sortOptions && sortOptions.bumped_on === -1) {
                  filtered.sort((a, b) => new Date(b.bumped_on) - new Date(a.bumped_on));
                }

                if (limitNum) {
                  filtered = filtered.slice(0, limitNum);
                }

                if (options.projection) {
                  filtered = filtered.map(item => {
                    const projected = { ...item };
                    Object.keys(options.projection).forEach(key => {
                      if (options.projection[key] === 0) {
                        delete projected[key];
                      }
                    });
                    return projected;
                  });
                }

                return filtered;
              }
            })
          })
        }),

        findOne: async (query, options = {}) => {
          let thread = threads.find(t => {
            if (query._id && t._id.toString() !== query._id.toString()) return false;
            if (query.board && t.board !== query.board) return false;
            return true;
          });

          if (thread && options.projection) {
            thread = { ...thread };
            Object.keys(options.projection).forEach(key => {
              if (options.projection[key] === 0) {
                delete thread[key];
              }
            });
          }

          return thread;
        },

        updateOne: async (query, update) => {
          const threadIndex = threads.findIndex(t => {
            if (query._id && t._id.toString() !== query._id.toString()) return false;
            if (query.board && t.board !== query.board) return false;
            if (query['replies._id']) {
              const replyExists = t.replies && t.replies.some(r => r._id.toString() === query['replies._id'].toString());
              if (!replyExists) return false;
            }
            return true;
          });

          if (threadIndex === -1) return { matchedCount: 0 };

          const thread = threads[threadIndex];

          if (update.$set) {
            if (update.$set['replies.$.reported']) {
              const replyIndex = thread.replies.findIndex(r => r._id.toString() === query['replies._id'].toString());
              if (replyIndex !== -1) {
                thread.replies[replyIndex].reported = true;
              }
            } else if (update.$set['replies.$.text']) {
              const replyIndex = thread.replies.findIndex(r => r._id.toString() === query['replies._id'].toString());
              if (replyIndex !== -1) {
                thread.replies[replyIndex].text = update.$set['replies.$.text'];
              }
            } else {
              Object.assign(thread, update.$set);
            }
          }

          if (update.$push) {
            Object.keys(update.$push).forEach(key => {
              if (!thread[key]) thread[key] = [];
              thread[key].push(update.$push[key]);
            });
          }

          return { matchedCount: 1 };
        },

        deleteOne: async (query) => {
          const index = threads.findIndex(t => {
            if (query._id && t._id.toString() !== query._id.toString()) return false;
            if (query.board && t.board !== query.board) return false;
            return true;
          });

          if (index > -1) {
            threads.splice(index, 1);
            return { deletedCount: 1 };
          }
          return { deletedCount: 0 };
        }
      };
    }
  };
  return memoryDB;
}

// Intentar conectar a MongoDB, si falla usar almacenamiento en memoria
async function startServer() {
  try {
    console.log('Attempting to connect to MongoDB...');
    const client = await MongoClient.connect(MONGO_URI);
    const db = client.db();
    app.locals.db = db;
    console.log('Connected to MongoDB successfully');

    // ✅ Montar rutas API
    apiRoutes(app);

    startExpressServer();

  } catch (err) {
    console.log('MongoDB connection failed, using memory storage for development:', err.message);

    // Usar almacenamiento en memoria
    app.locals.db = createMemoryStorage();

    // ✅ Montar rutas API también aquí
    apiRoutes(app);

    startExpressServer();
  }
}

function startExpressServer() {
  // 404 Not Found Middleware
  app.use(function(req, res, next) {
    res.status(404)
      .type('text')
      .send('Not Found');
  });

  // Start our server and tests!
  const listener = app.listen(PORT, '0.0.0.0', function () {
    console.log('Your app is listening on port ' + listener.address().port);

    if (process.env.NODE_ENV === 'test') {
      console.log('Running Tests...');
      setTimeout(function () {
        try {
          runner.run();
        } catch(e) {
          console.log('Tests are not valid:');
          console.error(e);
        }
      }, 1500);
    }
  });
}

// Iniciar el servidor
startServer();

module.exports = app; // for testing
