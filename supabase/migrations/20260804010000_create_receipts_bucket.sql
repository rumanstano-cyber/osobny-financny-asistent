-- Private bucket; only the backend service role uploads receipt originals.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ofa-receipts', 'ofa-receipts', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
