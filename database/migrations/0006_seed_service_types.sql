INSERT INTO service_types (code, name) VALUES
  ('internet', 'Internet'),
  ('cable', 'Cable'),
  ('combo', 'Combo (Internet + Cable)')
ON CONFLICT (code) DO NOTHING;