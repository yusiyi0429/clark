-- 新首页 17.2：「偏好」里的外观存在服务端，换设备一样。没设过（没有行或为空）是跟随系统。
ALTER TABLE person_settings ADD COLUMN appearance TEXT CHECK (appearance IN ('system', 'light', 'dark'));
