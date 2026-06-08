DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'TV'
      AND enumtypid = '"Role"'::regtype
  ) THEN
    ALTER TYPE "Role" ADD VALUE 'TV';
  END IF;
END $$;
