import { body, param, query } from 'express-validator'

export const usuarioCreateValidator = [
  body('nya')
    .trim()
    .notEmpty()
    .withMessage('nya es requerido'),

  body('dni')
    .trim()
    .notEmpty()
    .withMessage('dni es requerido'),

  // 📧 Email OPCIONAL: si viene vacío o no viene, no valida;
  // si viene con algo, debe ser un email válido.
  body('email')
    .optional({ checkFalsy: true })
    .trim()
    .isEmail()
    .withMessage('email inválido'),

  // 📞 Teléfono opcional (como antes, pero más explícito)
  body('telefono')
    .optional({ checkFalsy: true })
    .isString()
]

export const categoriaCreateValidator = [
  body('descripcion')
    .trim()
    .notEmpty()
    .withMessage('descripcion es requerida')
]

export const denunciaCreateValidator = [
  body('descripcion')
    .trim()
    .notEmpty()
    .withMessage('descripcion es requerida'),

  body('ubicacion')
    .trim()
    .notEmpty()
    .withMessage('ubicacion es requerida'),

  body('categoria')
    .isInt()
    .withMessage('categoria debe ser id numérico'),

  body('localidad')
    .isInt({ gt: 0 })
    .withMessage('localidad debe ser un id numérico > 0'),

  body('usuario')
    .isInt()
    .withMessage('usuario debe ser id numérico'),

  body('privado')
    .optional()
    .isBoolean()
    .withMessage('es_anonima debe ser booleano')
]

export const idParamValidator = [
  param('id')
    .isInt()
    .withMessage('id debe ser numérico')
]

export const denunciasQueryByUsuario = [
  query('usuario_id')
    .optional()
    .isInt()
    .withMessage('usuario_id debe ser numérico')
]

// import { body, param, query } from 'express-validator'


// export const usuarioCreateValidator = [
// body('nya').trim().notEmpty().withMessage('nya es requerido'),
// body('dni').trim().notEmpty().withMessage('dni es requerido'),
// body('email').isEmail().withMessage('email inválido'),
// body('telefono').optional().isString()
// ]


// export const categoriaCreateValidator = [
// body('descripcion').trim().notEmpty().withMessage('descripcion es requerida')
// ]


// export const denunciaCreateValidator = [
// body('descripcion').trim().notEmpty().withMessage('descripcion es requerida'),
// body('ubicacion').trim().notEmpty().withMessage('ubicacion es requerida'),
// body('categoria').isInt().withMessage('categoria debe ser id numérico'),
// body('localidad').isInt({ gt: 0 }).withMessage('localidad debe ser un id numérico > 0'),
// body('usuario').isInt().withMessage('usuario debe ser id numérico'),
// body('privado').optional().isBoolean().withMessage('es_anonima debe ser booleano')
// ]


// export const idParamValidator = [
// param('id').isInt().withMessage('id debe ser numérico')
// ]


// export const denunciasQueryByUsuario = [
// query('usuario_id').optional().isInt().withMessage('usuario_id debe ser numérico')
// ]