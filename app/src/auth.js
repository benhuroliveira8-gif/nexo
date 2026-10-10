const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('Defina JWT_SECRET (pelo menos 16 caracteres) no arquivo .env');
  process.exit(1);
}

const hashPassword = (password) => bcrypt.hash(password, 10);
const checkPassword = (password, hash) => bcrypt.compare(password, hash);

const signToken = (user) =>
  jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '7d' });

// Devolve o id do usuário, ou null se o token for inválido/expirado.
function verifyToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return Number(payload.sub) || null;
  } catch {
    return null;
  }
}

// Middleware do Express: exige "Authorization: Bearer <token>".
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = token && verifyToken(token);
  if (!userId) return res.status(401).json({ error: 'Faça login para continuar.' });
  req.userId = userId;
  next();
}

module.exports = { hashPassword, checkPassword, signToken, verifyToken, requireAuth };
