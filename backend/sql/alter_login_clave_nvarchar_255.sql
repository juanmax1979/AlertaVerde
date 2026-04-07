/*
  Un hash bcrypt ocupa 60 caracteres. Si "clave" era NVARCHAR(50) o similar,
  el UPDATE se trunca (error 2628).

  Ejecutar una vez en la base AlertaVerde (ajustar NULL/NOT NULL si hace falta).
*/

-- Ver definición actual:
-- sp_help 'dbo.login';

ALTER TABLE dbo.login ALTER COLUMN clave NVARCHAR(255) NULL;
GO

-- Si la columna debe ser NOT NULL y hoy hay filas con NULL:
-- ALTER TABLE dbo.login ALTER COLUMN clave NVARCHAR(255) NOT NULL;
