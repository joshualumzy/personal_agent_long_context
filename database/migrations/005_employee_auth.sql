BEGIN;

ALTER TABLE employees
ADD COLUMN IF NOT EXISTS password_hash TEXT,
ADD COLUMN IF NOT EXISTS avatar TEXT;

-- 1. Primary demo accounts (prioritized in the UI persona switcher)
INSERT INTO employees (employee_id, display_name, role, department, current_assignments, password_hash, avatar)
VALUES
  ('jax',    'Jax',    'Backend Engineer',        'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '👨‍💻'),
  ('priya',  'Priya',  'Product Designer',        'Design',              '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🎨'),
  ('chloe',  'Chloe',  'Product Manager',         'Product',             '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '📋'),
  ('marcus', 'Marcus', 'Staff Systems Engineer',  'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🛠️'),
  ('deepa',  'Deepa',  'Infra Lead',              'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '⚡')
ON CONFLICT (employee_id) DO UPDATE SET
  password_hash = COALESCE(employees.password_hash, EXCLUDED.password_hash),
  avatar = COALESCE(employees.avatar, EXCLUDED.avatar);

-- 2. Complete company roster from OrgForge communication artifacts
INSERT INTO employees (employee_id, display_name, role, department, current_assignments, password_hash, avatar)
VALUES
  ('alex',     'Alex',     'Mobile Engineer',         'Engineering_Mobile',  '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '📱'),
  ('ariana',   'Ariana',   'Account Executive',       'Sales_Marketing',     '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '💼'),
  ('arun',     'Arun',     'Backend Engineer',        'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '💻'),
  ('ben',      'Ben',      'QA Automation Engineer',  'QA_Support',          '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🧪'),
  ('blake',    'Blake',    'Marketing Lead',          'Sales_Marketing',     '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '📣'),
  ('chris',    'Chris',    'Backend Engineer',        'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '⚙️'),
  ('cooper',   'Cooper',   'Visual Designer',         'Design',              '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🖌️'),
  ('dave',     'Dave',     'People Partner',          'HR_Ops',              '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🤝'),
  ('desmond',  'Desmond',  'UI/UX Designer',          'Design',              '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '✨'),
  ('elena',    'Elena',    'Product Manager',         'Product',             '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '📊'),
  ('ethan',    'Ethan',    'iOS Engineer',            'Engineering_Mobile',  '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🍏'),
  ('felix',    'Felix',    'QA Lead',                 'QA_Support',          '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🔍'),
  ('hanna',    'Hanna',    'Data Engineer',           'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '📈'),
  ('isabel',   'Isabel',   'Sales Representative',    'Sales_Marketing',     '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🎯'),
  ('jamie',    'Jamie',    'Senior Designer',         'Design',              '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '📐'),
  ('janice',   'Janice',   'HR Generalist',           'HR_Ops',              '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '👥'),
  ('jenna',    'Jenna',    'Growth Marketing',        'Sales_Marketing',     '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🚀'),
  ('jordan',   'Jordan',   'Android Engineer',        'Engineering_Mobile',  '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🤖'),
  ('kaitlyn',  'Kaitlyn',  'Backend Engineer',        'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '💾'),
  ('karen',    'Karen',    'HR Operations Lead',      'HR_Ops',              '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🗂️'),
  ('lena',     'Lena',     'Platform Engineer',       'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🏗️'),
  ('liam',     'Liam',     'Systems Engineer',        'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🔧'),
  ('marc',     'Marc',     'Design Director',         'Design',              '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🎭'),
  ('mike',     'Mike',     'Product Operations',      'Product',             '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🧭'),
  ('miki',     'Miki',     'Mobile Engineer',         'Engineering_Mobile',  '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '📲'),
  ('mona',     'Mona',     'Backend Engineer',        'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🔌'),
  ('morgan',   'Morgan',   'Database Engineer',       'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🗄️'),
  ('nadia',    'Nadia',    'Support Engineer',        'QA_Support',          '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🎧'),
  ('nisha',    'Nisha',    'Sales Operations',        'Sales_Marketing',     '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🏷️'),
  ('nora',     'Nora',     'Vendor Relations',        'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '📦'),
  ('patty',    'Patty',    'Head of People',          'HR_Ops',              '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🌟'),
  ('raj',      'Raj',      'Mobile Lead',             'Engineering_Mobile',  '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '📡'),
  ('ravi',     'Ravi',     'Backend Engineer',        'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '💻'),
  ('reese',    'Reese',    'Benefits Coordinator',    'HR_Ops',              '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🎁'),
  ('sam',      'Sam',      'iOS Engineer',            'Engineering_Mobile',  '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🍎'),
  ('sanjay',   'Sanjay',   'Infrastructure Engineer', 'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🌐'),
  ('sarah',    'Sarah',    'VP of Product',           'Product',             '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '👑'),
  ('sophie',   'Sophie',   'Design Systems Lead',     'Design',              '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🧩'),
  ('tasha',    'Tasha',    'Backend Engineer',        'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🧱'),
  ('taylor',   'Taylor',   'Mobile QA Engineer',      'Engineering_Mobile',  '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🔬'),
  ('tom',      'Tom',      'Facilities & Ops Lead',   'HR_Ops',              '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🏢'),
  ('umji',     'Umji',     'QA Engineer',             'QA_Support',          '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🩺'),
  ('vince',    'Vince',    'Motion Designer',         'Design',              '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🎬'),
  ('yara',     'Yara',     'Support Specialist',      'QA_Support',          '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '💬'),
  ('yusuf',    'Yusuf',    'Engineering Manager',     'Engineering_Backend', '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '🎖️'),
  ('zoe',      'Zoe',      'Customer Operations',     'QA_Support',          '[]'::jsonb, '1cafb4e0576f1a1c180176527443d2ef86c7ee7b876c37c9d7e12166c13e7563b6d91097442baeb3c8b4ed3e0795aa22a2b306dec31f64f24ce8ac7e5d1f5235', '💡')
ON CONFLICT (employee_id) DO UPDATE SET
  password_hash = COALESCE(employees.password_hash, EXCLUDED.password_hash),
  avatar = COALESCE(employees.avatar, EXCLUDED.avatar);

COMMIT;
