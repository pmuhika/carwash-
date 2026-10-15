-- Bar POS Cloud schema for Supabase/Postgres
-- Run this entire file in Supabase SQL Editor as the project owner.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  role text not null default 'cashier' check (role in ('admin','cashier')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'Other',
  sku text unique,
  cost_price numeric(12,2) not null default 0 check (cost_price >= 0),
  sell_price numeric(12,2) not null default 0 check (sell_price >= 0),
  stock_qty integer not null default 0 check (stock_qty >= 0),
  min_stock integer not null default 5 check (min_stock >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  receipt_no text not null unique,
  cashier_id uuid not null references public.profiles(id),
  subtotal numeric(12,2) not null check (subtotal >= 0),
  total numeric(12,2) not null check (total >= 0),
  cost_total numeric(12,2) not null default 0 check (cost_total >= 0),
  payment_method text not null check (payment_method in ('cash','mpesa','card','credit','other')),
  creditor_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  product_id uuid not null references public.products(id),
  product_name text not null,
  quantity integer not null check (quantity > 0),
  unit_cost numeric(12,2) not null check (unit_cost >= 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  line_total numeric(12,2) not null check (line_total >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  user_id uuid not null references public.profiles(id),
  movement_type text not null check (movement_type in ('opening','receive','sale','adjustment','wastage')),
  quantity_change integer not null,
  quantity_after integer not null check (quantity_after >= 0),
  note text not null default '',
  reference_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists sales_created_at_idx on public.sales(created_at desc);
create index if not exists sales_cashier_created_idx on public.sales(cashier_id, created_at desc);
create index if not exists sale_items_sale_idx on public.sale_items(sale_id);
create index if not exists stock_movements_product_idx on public.stock_movements(product_id, created_at desc);
create index if not exists products_active_name_idx on public.products(active, name);

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.profiles p where p.id = auth.uid() and p.active = true); $$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.profiles p where p.id = auth.uid() and p.active = true and p.role = 'admin'); $$;

-- Automatically create a cashier profile for newly registered auth users.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id, full_name, role, active)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''), 'cashier', true)
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created_barpos on auth.users;
create trigger on_auth_user_created_barpos after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.stock_movements enable row level security;
alter table public.expenses enable row level security;
alter table public.sales drop constraint if exists sales_payment_method_check;
alter table public.sales add constraint sales_payment_method_check check (payment_method in ('cash','mpesa','card','credit','other'));
alter table public.sales add column if not exists creditor_name text;

drop policy if exists "profile read own or admin" on public.profiles;
create policy "profile read own or admin" on public.profiles for select to authenticated
using (id = auth.uid() or public.is_admin());
drop policy if exists "admin update profiles" on public.profiles;
create policy "admin update profiles" on public.profiles for update to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "active users read products" on public.products;
create policy "active users read products" on public.products for select to authenticated using (public.is_active_user());
drop policy if exists "admin insert products" on public.products;
create policy "admin insert products" on public.products for insert to authenticated with check (public.is_admin());
drop policy if exists "admin update products" on public.products;
create policy "admin update products" on public.products for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "cashiers read own sales admin reads all" on public.sales;
create policy "cashiers read own sales admin reads all" on public.sales for select to authenticated
using (public.is_active_user() and (cashier_id = auth.uid() or public.is_admin()));
drop policy if exists "sales items own or admin" on public.sale_items;
create policy "sales items own or admin" on public.sale_items for select to authenticated
using (exists(select 1 from public.sales s where s.id = sale_id and (s.cashier_id = auth.uid() or public.is_admin())));
drop policy if exists "expenses admin read" on public.expenses;
create policy "expenses admin read" on public.expenses for select to authenticated using (public.is_admin());
drop policy if exists "expenses admin insert" on public.expenses;
create policy "expenses admin insert" on public.expenses for insert to authenticated with check (public.is_admin() and created_by = auth.uid());
drop policy if exists "stock movements admin or active users" on public.stock_movements;
create policy "stock movements admin or active users" on public.stock_movements for select to authenticated using (public.is_active_user() and (public.is_admin() or user_id = auth.uid()));

-- New products with opening stock also create an auditable opening movement.
create or replace function public.record_opening_stock()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.stock_qty > 0 then
    insert into public.stock_movements(product_id,user_id,movement_type,quantity_change,quantity_after,note)
    values(new.id,auth.uid(),'opening',new.stock_qty,new.stock_qty,'Opening stock');
  end if;
  return new;
end;
$$;
drop trigger if exists products_opening_stock_trigger on public.products;
create trigger products_opening_stock_trigger after insert on public.products
for each row execute procedure public.record_opening_stock();

-- Atomic checkout: validates all requested items, locks inventory rows, decrements stock,
-- writes the sale + line items + movements in a single transaction.
drop function if exists public.checkout_sale(jsonb,text);
create or replace function public.checkout_sale(p_items jsonb, p_payment_method text, p_creditor_name text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_sale_id uuid := gen_random_uuid();
  v_receipt text;
  v_subtotal numeric(12,2) := 0;
  v_cost_total numeric(12,2) := 0;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_line numeric(12,2);
  v_total_items integer := 0;
begin
  if v_user is null or not public.is_active_user() then raise exception 'Your account is inactive or not signed in'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Cart is empty'; end if;
  if p_payment_method not in ('cash','mpesa','card','credit','other') then raise exception 'Invalid payment method'; end if;
  if p_payment_method = 'credit' and nullif(trim(p_creditor_name),'') is null then raise exception 'Creditor name is required for credit sales'; end if;
  -- Sort by product id to reduce deadlock risk if two terminals sell overlapping products.
  for v_item in select value from jsonb_array_elements(p_items) order by value->>'product_id' loop
    if coalesce(v_item->>'product_id','') = '' then raise exception 'Product id is required'; end if;
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then raise exception 'Quantity must be a positive whole number'; end if;
    select * into v_product from public.products where id=(v_item->>'product_id')::uuid and active=true for update;
    if not found then raise exception 'A product was not found or is inactive'; end if;
    if v_product.stock_qty < v_qty then raise exception 'Insufficient stock for % (available %, requested %)',v_product.name,v_product.stock_qty,v_qty; end if;
    v_line := round(v_product.sell_price * v_qty,2);
    v_subtotal := v_subtotal + v_line;
    v_cost_total := v_cost_total + round(v_product.cost_price * v_qty,2);
    v_total_items := v_total_items + v_qty;
  end loop;
  v_receipt := 'BAR-' || to_char(now() at time zone 'Africa/Nairobi','YYMMDD-HH24MISS') || '-' || upper(substr(replace(v_sale_id::text,'-',''),1,6));
  insert into public.sales(id,receipt_no,cashier_id,subtotal,total,cost_total,payment_method,creditor_name)
  values(v_sale_id,v_receipt,v_user,v_subtotal,v_subtotal,v_cost_total,p_payment_method,case when p_payment_method='credit' then trim(p_creditor_name) else null end);
  for v_item in select value from jsonb_array_elements(p_items) order by value->>'product_id' loop
    v_qty := (v_item->>'quantity')::integer;
    select * into v_product from public.products where id=(v_item->>'product_id')::uuid and active=true for update;
    -- Duplicate product lines are safely processed one at a time; stock is rechecked.
    if v_product.stock_qty < v_qty then raise exception 'Insufficient stock for %',v_product.name; end if;
    v_line := round(v_product.sell_price * v_qty,2);
    update public.products set stock_qty=stock_qty-v_qty, updated_at=now() where id=v_product.id returning * into v_product;
    insert into public.sale_items(sale_id,product_id,product_name,quantity,unit_cost,unit_price,line_total)
    values(v_sale_id,v_product.id,v_product.name,v_qty,v_product.cost_price,v_product.sell_price,v_line);
    insert into public.stock_movements(product_id,user_id,movement_type,quantity_change,quantity_after,note,reference_id)
    values(v_product.id,v_user,'sale',-v_qty,v_product.stock_qty,'Sale '||v_receipt,v_sale_id);
  end loop;
  return jsonb_build_object('id',v_sale_id,'receipt_no',v_receipt,'total',v_subtotal,'cost_total',v_cost_total,'item_count',v_total_items);
end;
$$;

create or replace function public.receive_stock(p_product_id uuid, p_quantity integer, p_note text default 'Stock received')
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_user uuid := auth.uid(); v_product public.products%rowtype;
begin
  if v_user is null or not public.is_active_user() then raise exception 'Your account is inactive or not signed in'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be a positive whole number'; end if;
  if not public.is_admin() then raise exception 'Only an administrator can receive stock'; end if;
  select * into v_product from public.products where id=p_product_id and active=true for update;
  if not found then raise exception 'Product not found or inactive'; end if;
  update public.products set stock_qty=stock_qty+p_quantity,updated_at=now() where id=p_product_id returning * into v_product;
  insert into public.stock_movements(product_id,user_id,movement_type,quantity_change,quantity_after,note)
  values(v_product.id,v_user,'receive',p_quantity,v_product.stock_qty,coalesce(nullif(p_note,''),'Stock received'));
  return jsonb_build_object('product_id',v_product.id,'stock_qty',v_product.stock_qty);
end;
$$;

-- RPC functions are callable by signed-in users; authorization is checked inside each function.
revoke all on function public.checkout_sale(jsonb,text,text) from public;
grant execute on function public.checkout_sale(jsonb,text,text) to authenticated;
revoke all on function public.receive_stock(uuid,integer,text) from public;
grant execute on function public.receive_stock(uuid,integer,text) to authenticated;
revoke all on function public.is_active_user() from public;
grant execute on function public.is_active_user() to authenticated;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

grant select on public.profiles, public.products, public.sales, public.sale_items, public.stock_movements, public.expenses to authenticated;
grant insert on public.expenses to authenticated;
grant insert, update on public.products to authenticated;
grant update on public.profiles to authenticated;

-- Bar operations extension: packaging conversion, receipt-level receiving, and inventory audits.
alter table public.products add column if not exists image_url text;
alter table public.products add column if not exists stock_unit text not null default 'unit' check (stock_unit in ('unit','barrel'));
alter table public.products add column if not exists units_per_pack integer not null default 100 check (units_per_pack > 0);
create table if not exists public.stock_receipts (
 id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products(id),
 received_by uuid not null references public.profiles(id), quantity_units integer not null check(quantity_units > 0),
 total_cost numeric(12,2) not null default 0 check(total_cost >= 0), unit_cost numeric(12,4) not null default 0,
 supplier text, supplier_receipt_no text, note text not null default '', created_at timestamptz not null default now()
);
alter table public.stock_receipts enable row level security;
drop policy if exists "admin read stock receipts" on public.stock_receipts;
create policy "admin read stock receipts" on public.stock_receipts for select to authenticated using(public.is_admin());
grant select on public.stock_receipts to authenticated;

create or replace function public.receive_stock_details(p_product_id uuid,p_quantity integer,p_total_cost numeric,p_supplier text default null,p_receipt_no text default null,p_note text default 'Stock received')
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_product public.products%rowtype; v_new_qty integer; v_unit_cost numeric(12,4); v_weighted_cost numeric(12,2);
begin
 if v_user is null or not public.is_active_user() then raise exception 'Your account is inactive or not signed in'; end if;
 if not public.is_admin() then raise exception 'Only an administrator can receive stock'; end if;
 if p_quantity is null or p_quantity<=0 then raise exception 'Quantity must be a positive whole number'; end if;
 if p_total_cost is null or p_total_cost<0 then raise exception 'Total cost must not be negative'; end if;
 select * into v_product from public.products where id=p_product_id and active=true for update;
 if not found then raise exception 'Product not found or inactive'; end if;
 v_new_qty:=v_product.stock_qty+p_quantity;
 v_unit_cost:=case when p_quantity>0 then round(p_total_cost/p_quantity,4) else 0 end;
 v_weighted_cost:=case when v_new_qty>0 then round(((v_product.stock_qty*v_product.cost_price)+(p_total_cost))/(v_new_qty),2) else v_product.cost_price end;
 update public.products set stock_qty=v_new_qty,cost_price=v_weighted_cost,updated_at=now() where id=p_product_id;
 insert into public.stock_movements(product_id,user_id,movement_type,quantity_change,quantity_after,note)
 values(p_product_id,v_user,'receive',p_quantity,v_new_qty,coalesce(nullif(p_note,''),'Stock received')||case when nullif(p_receipt_no,'') is not null then ' · Receipt '||p_receipt_no else '' end);
 insert into public.stock_receipts(product_id,received_by,quantity_units,total_cost,unit_cost,supplier,supplier_receipt_no,note)
 values(p_product_id,v_user,p_quantity,p_total_cost,v_unit_cost,nullif(trim(p_supplier),''),nullif(trim(p_receipt_no),''),coalesce(p_note,''));
 return jsonb_build_object('product_id',p_product_id,'stock_qty',v_new_qty,'unit_cost',v_unit_cost,'weighted_cost',v_weighted_cost);
end; $$;

create or replace function public.adjust_stock(p_product_id uuid,p_new_quantity integer,p_note text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_product public.products%rowtype; v_diff integer;
begin
 if v_user is null or not public.is_active_user() then raise exception 'Your account is inactive or not signed in'; end if;
 if not public.is_admin() then raise exception 'Only an administrator can adjust inventory'; end if;
 if p_new_quantity is null or p_new_quantity<0 then raise exception 'Physical count cannot be negative'; end if;
 select * into v_product from public.products where id=p_product_id and active=true for update;
 if not found then raise exception 'Product not found or inactive'; end if;
 v_diff:=p_new_quantity-v_product.stock_qty;
 update public.products set stock_qty=p_new_quantity,updated_at=now() where id=p_product_id;
 insert into public.stock_movements(product_id,user_id,movement_type,quantity_change,quantity_after,note)
 values(p_product_id,v_user,'adjustment',v_diff,p_new_quantity,coalesce(nullif(trim(p_note),''),'Inventory audit adjustment'));
 return jsonb_build_object('product_id',p_product_id,'quantity_change',v_diff,'stock_qty',p_new_quantity);
end; $$;
revoke all on function public.receive_stock_details(uuid,integer,numeric,text,text,text) from public;
grant execute on function public.receive_stock_details(uuid,integer,numeric,text,text,text) to authenticated;
revoke all on function public.adjust_stock(uuid,integer,text) from public;
grant execute on function public.adjust_stock(uuid,integer,text) to authenticated;

-- ========== v1.4 extensions: credits ledger, settings, activity log, permissions ==========

alter table public.profiles add column if not exists allowed_tabs text[] default array['Dashboard','Sell','Credits','Expenses'];
alter table public.profiles add column if not exists pin_hash text;

create table if not exists public.app_settings (
  id int primary key default 1 check (id = 1),
  bar_name text not null default 'Bar POS',
  logo_url text,
  till_number text default '',
  receipt_footer text default 'Thank you for your patronage!',
  show_till_on_receipt boolean not null default true,
  show_cashier_on_receipt boolean not null default true,
  admin_pin_hash text,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.credit_payments (
  id uuid primary key default gen_random_uuid(),
  creditor_name text not null,
  amount numeric(12,2) not null check (amount > 0),
  payment_method text not null default 'cash' check (payment_method in ('cash','mpesa','card','other')),
  note text default '',
  receipt_no text,
  recorded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id),
  action text not null,
  details text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists credit_payments_name_idx on public.credit_payments(creditor_name, created_at desc);
create index if not exists activity_log_created_idx on public.activity_log(created_at desc);

alter table public.app_settings enable row level security;
alter table public.credit_payments enable row level security;
alter table public.activity_log enable row level security;

drop policy if exists "settings read active" on public.app_settings;
create policy "settings read active" on public.app_settings for select to authenticated using (public.is_active_user());
drop policy if exists "settings admin update" on public.app_settings;
create policy "settings admin update" on public.app_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "credit payments read" on public.credit_payments;
create policy "credit payments read" on public.credit_payments for select to authenticated using (public.is_active_user());
drop policy if exists "credit payments insert" on public.credit_payments;
create policy "credit payments insert" on public.credit_payments for insert to authenticated with check (public.is_active_user() and recorded_by = auth.uid());
drop policy if exists "credit payments admin delete" on public.credit_payments;
create policy "credit payments admin delete" on public.credit_payments for delete to authenticated using (public.is_admin());

drop policy if exists "activity log read admin" on public.activity_log;
create policy "activity log read admin" on public.activity_log for select to authenticated using (public.is_admin());
drop policy if exists "activity log insert active" on public.activity_log;
create policy "activity log insert active" on public.activity_log for insert to authenticated with check (public.is_active_user());

grant select, update on public.app_settings to authenticated;
grant select, insert, delete on public.credit_payments to authenticated;
grant select, insert on public.activity_log to authenticated;

-- Helper to log activity
create or replace function public.log_activity(p_action text, p_details text default '')
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.activity_log(user_id, action, details)
  values (auth.uid(), p_action, coalesce(p_details, ''));
end;
$$;
grant execute on function public.log_activity(text, text) to authenticated;

-- Function to record a credit payment and optionally log
create or replace function public.record_credit_payment(
  p_creditor_name text,
  p_amount numeric,
  p_payment_method text default 'cash',
  p_note text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_receipt text;
  v_id uuid := gen_random_uuid();
begin
  if v_user is null or not public.is_active_user() then
    raise exception 'Not signed in or inactive';
  end if;
  if nullif(trim(p_creditor_name), '') is null then
    raise exception 'Creditor name required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be positive';
  end if;
  v_receipt := 'CRP-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(v_id::text, '-', ''), 1, 6));
  insert into public.credit_payments(id, creditor_name, amount, payment_method, note, receipt_no, recorded_by)
  values (v_id, trim(p_creditor_name), p_amount, p_payment_method, coalesce(p_note, ''), v_receipt, v_user);
  perform public.log_activity('credit_payment', 'Paid ' || p_amount::text || ' for ' || trim(p_creditor_name));
  return jsonb_build_object('id', v_id, 'receipt_no', v_receipt, 'amount', p_amount);
end;
$$;
grant execute on function public.record_credit_payment(text, numeric, text, text) to authenticated;


-- ========== v1.5: suppliers ledger ==========
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  phone text default '',
  note text default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.stock_receipts add column if not exists supplier_id uuid references public.suppliers(id);
alter table public.app_settings add column if not exists dark_mode boolean not null default false;

alter table public.suppliers enable row level security;
drop policy if exists "suppliers read active" on public.suppliers;
create policy "suppliers read active" on public.suppliers for select to authenticated using (public.is_active_user());
drop policy if exists "suppliers admin write" on public.suppliers;
create policy "suppliers admin write" on public.suppliers for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.suppliers to authenticated;


-- v1.6 staff PIN login helpers
alter table public.profiles add column if not exists staff_code text unique;
alter table public.profiles add column if not exists login_email text;

-- First auth user becomes admin automatically
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_count int;
begin
  select count(*) into v_count from public.profiles;
  insert into public.profiles(id, full_name, role, active, login_email, allowed_tabs)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name',''),
    case when v_count = 0 then 'admin' else 'cashier' end,
    true,
    new.email,
    case when v_count = 0 then array[
      'Dashboard','Sell','Receive Stock','Inventory','Products','Credits','Suppliers',
      'Expenses','Reports','Users','Activity Log','Backup & Settings','Sales'
    ] else array['Dashboard','Sell','Credits'] end
  )
  on conflict (id) do update set login_email = excluded.login_email;
  return new;
end;
$$;


-- Factory reset is defined once at end of this file (full wipe). Do not use a soft version here.

-- Admin notifications for stock actions by any staff
create table if not exists public.admin_notifications (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  title text not null,
  body text not null default '',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists admin_notifications_unread_idx
  on public.admin_notifications (created_at desc) where read_at is null;

alter table public.admin_notifications enable row level security;
drop policy if exists "admin notifications read" on public.admin_notifications;
create policy "admin notifications read" on public.admin_notifications
  for select to authenticated using (public.is_admin());
drop policy if exists "admin notifications update" on public.admin_notifications;
create policy "admin notifications update" on public.admin_notifications
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.notify_admin(p_type text, p_title text, p_body text default '')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  insert into public.admin_notifications(type, title, body, created_by)
  values (coalesce(p_type,'info'), coalesce(p_title,'Notice'), coalesce(p_body,''), auth.uid());
end;
$$;
grant execute on function public.notify_admin(text, text, text) to authenticated;

create or replace function public.mark_admin_notifications_read()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admin can mark notifications read';
  end if;
  update public.admin_notifications set read_at = now() where read_at is null;
end;
$$;
grant execute on function public.mark_admin_notifications_read() to authenticated;

-- Allow any active staff (not only admin) to receive stock / audit inventory
create or replace function public.receive_stock_details(
  p_product_id uuid,
  p_quantity integer,
  p_total_cost numeric,
  p_supplier text default null,
  p_receipt_no text default null,
  p_note text default 'Stock received'
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_user uuid := auth.uid();
  v_product public.products%rowtype;
  v_new_qty integer;
  v_unit_cost numeric;
  v_who text;
begin
  if v_user is null or not public.is_active_user() then
    raise exception 'Your account is inactive or not signed in';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be a positive whole number';
  end if;
  select * into v_product from public.products where id = p_product_id and active = true for update;
  if not found then raise exception 'Product not found or inactive'; end if;
  v_new_qty := v_product.stock_qty + p_quantity;
  v_unit_cost := case when p_quantity > 0 then round(p_total_cost / p_quantity, 4) else 0 end;
  update public.products
    set stock_qty = v_new_qty,
        cost_price = case when p_total_cost > 0 then v_unit_cost else cost_price end,
        updated_at = now()
    where id = p_product_id;
  insert into public.stock_movements(product_id, user_id, movement_type, quantity_change, quantity_after, note)
  values (
    p_product_id, v_user, 'receive', p_quantity, v_new_qty,
    coalesce(nullif(p_note, ''), 'Stock received')
      || case when nullif(p_receipt_no, '') is not null then ' · Receipt ' || p_receipt_no else '' end
  );
  insert into public.stock_receipts(product_id, received_by, quantity, total_cost, unit_cost, supplier_name, receipt_no, note)
  values (
    p_product_id, v_user, p_quantity, p_total_cost, v_unit_cost,
    nullif(trim(p_supplier), ''), nullif(trim(p_receipt_no), ''), coalesce(p_note, '')
  );
  select coalesce(full_name, 'Staff') into v_who from public.profiles where id = v_user;
  perform public.notify_admin(
    'stock_receive',
    'Stock received: ' || v_product.name,
    coalesce(v_who, 'Staff') || ' received ' || p_quantity::text || ' × ' || v_product.name
      || case when nullif(trim(p_supplier), '') is not null then ' from ' || trim(p_supplier) else '' end
      || '. New qty: ' || v_new_qty::text
  );
  return jsonb_build_object('product_id', p_product_id, 'stock_qty', v_new_qty, 'unit_cost', v_unit_cost);
end;
$$;

create or replace function public.adjust_stock(p_product_id uuid, p_new_quantity integer, p_note text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_user uuid := auth.uid();
  v_product public.products%rowtype;
  v_diff integer;
  v_who text;
begin
  if v_user is null or not public.is_active_user() then
    raise exception 'Your account is inactive or not signed in';
  end if;
  if p_new_quantity is null or p_new_quantity < 0 then
    raise exception 'Physical count cannot be negative';
  end if;
  select * into v_product from public.products where id = p_product_id and active = true for update;
  if not found then raise exception 'Product not found or inactive'; end if;
  v_diff := p_new_quantity - v_product.stock_qty;
  update public.products set stock_qty = p_new_quantity, updated_at = now() where id = p_product_id;
  insert into public.stock_movements(product_id, user_id, movement_type, quantity_change, quantity_after, note)
  values (p_product_id, v_user, 'adjustment', v_diff, p_new_quantity, coalesce(nullif(trim(p_note), ''), 'Inventory audit adjustment'));
  select coalesce(full_name, 'Staff') into v_who from public.profiles where id = v_user;
  perform public.notify_admin(
    'inventory_audit',
    'Stock audit: ' || v_product.name,
    coalesce(v_who, 'Staff') || ' audited ' || v_product.name
      || ' — expected ' || v_product.stock_qty::text
      || ' → counted ' || p_new_quantity::text
      || ' (var ' || case when v_diff >= 0 then '+' else '' end || v_diff::text || ')'
      || case when nullif(trim(p_note), '') is not null then ' · ' || trim(p_note) else '' end
  );
  return jsonb_build_object('product_id', p_product_id, 'quantity_change', v_diff, 'stock_qty', p_new_quantity);
end;
$$;


-- Enable Realtime for live multi-device sync (run in SQL Editor if needed)
-- Tables must be in the supabase_realtime publication
do $$
declare
  t text;
  tables text[] := array[
    'products','sales','sale_items','expenses','credit_payments',
    'stock_movements','stock_receipts','suppliers','app_settings',
    'profiles','activity_log','admin_notifications'
  ];
begin
  foreach t in array tables loop
    begin
      execute format(
        'alter publication supabase_realtime add table public.%I',
        t
      );
    exception when duplicate_object then
      null;
    when others then
      null;
    end;
  end loop;
end $$;

-- First-time setup + PIN-only login helpers
create or replace function public.bootstrap_status()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'needs_setup', (select count(*)::int from public.profiles) = 0,
    'user_count', (select count(*)::int from public.profiles)
  );
$$;
grant execute on function public.bootstrap_status() to anon, authenticated;

create or replace function public.resolve_pin_login(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text;
  v_count int;
  v_email text;
  v_name text;
  v_role text;
begin
  if p_pin is null or length(trim(p_pin)) < 4 then
    raise exception 'Enter a valid PIN';
  end if;
  v_hash := encode(convert_to(trim(p_pin), 'UTF8'), 'base64');
  select count(*) into v_count
  from public.profiles
  where active = true and pin_hash = v_hash;
  if v_count = 0 then
    raise exception 'Invalid PIN';
  end if;
  if v_count > 1 then
    raise exception 'PIN is not unique. Ask admin to set a unique PIN.';
  end if;
  select coalesce(nullif(login_email, ''), email_from_auth), full_name, role
  into v_email, v_name, v_role
  from (
    select p.login_email, p.full_name, p.role,
           (select u.email from auth.users u where u.id = p.id) as email_from_auth
    from public.profiles p
    where p.active = true and p.pin_hash = v_hash
    limit 1
  ) x;
  if v_email is null or v_email = '' then
    raise exception 'Account has no login email. Ask admin to recreate the user.';
  end if;
  return jsonb_build_object(
    'email', v_email,
    'full_name', v_name,
    'role', v_role
  );
end;
$$;
grant execute on function public.resolve_pin_login(text) to anon, authenticated;

-- FIX receive_stock_details: use real stock_receipts column names
create or replace function public.receive_stock_details(
  p_product_id uuid,
  p_quantity integer,
  p_total_cost numeric,
  p_supplier text default null,
  p_receipt_no text default null,
  p_note text default 'Stock received'
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_user uuid := auth.uid();
  v_product public.products%rowtype;
  v_new_qty integer;
  v_unit_cost numeric;
  v_who text;
begin
  if v_user is null or not public.is_active_user() then
    raise exception 'Your account is inactive or not signed in';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be a positive whole number';
  end if;
  select * into v_product from public.products where id = p_product_id and active = true for update;
  if not found then raise exception 'Product not found or inactive'; end if;

  v_new_qty := v_product.stock_qty + p_quantity;
  v_unit_cost := case when p_quantity > 0 then round(coalesce(p_total_cost, 0) / p_quantity, 4) else 0 end;

  update public.products
    set stock_qty = v_new_qty,
        cost_price = case when coalesce(p_total_cost, 0) > 0 then v_unit_cost else cost_price end,
        updated_at = now()
    where id = p_product_id;

  insert into public.stock_movements(product_id, user_id, movement_type, quantity_change, quantity_after, note)
  values (
    p_product_id, v_user, 'receive', p_quantity, v_new_qty,
    coalesce(nullif(p_note, ''), 'Stock received')
      || case when nullif(p_receipt_no, '') is not null then ' · Receipt ' || p_receipt_no else '' end
  );

  -- Match actual table columns: quantity_units, supplier, supplier_receipt_no
  insert into public.stock_receipts(
    product_id, received_by, quantity_units, total_cost, unit_cost, supplier, supplier_receipt_no, note
  )
  values (
    p_product_id, v_user, p_quantity, coalesce(p_total_cost, 0), v_unit_cost,
    nullif(trim(coalesce(p_supplier, '')), ''),
    nullif(trim(coalesce(p_receipt_no, '')), ''),
    coalesce(p_note, '')
  );

  begin
    select coalesce(full_name, 'Staff') into v_who from public.profiles where id = v_user;
    perform public.notify_admin(
      'stock_receive',
      'Stock received: ' || v_product.name,
      coalesce(v_who, 'Staff') || ' received ' || p_quantity::text || ' × ' || v_product.name
        || case when nullif(trim(coalesce(p_supplier, '')), '') is not null
            then ' from ' || trim(p_supplier) else '' end
        || '. New qty: ' || v_new_qty::text
    );
  exception when others then
    null; -- never fail receive because of notification
  end;

  return jsonb_build_object(
    'product_id', p_product_id,
    'stock_qty', v_new_qty,
    'unit_cost', v_unit_cost
  );
end;
$$;
grant execute on function public.receive_stock_details(uuid, integer, numeric, text, text, text) to authenticated;

-- Allow any active staff to record expenses (not only admin)
drop policy if exists "expenses admin insert" on public.expenses;
drop policy if exists "expenses active insert" on public.expenses;
create policy "expenses active insert" on public.expenses
  for insert to authenticated
  with check (public.is_active_user() and created_by = auth.uid());

drop policy if exists "expenses admin read" on public.expenses;
drop policy if exists "expenses read own or admin" on public.expenses;
create policy "expenses read own or admin" on public.expenses
  for select to authenticated
  using (public.is_active_user() and (created_by = auth.uid() or public.is_admin()));

-- Inventory audit: ensure active staff can call adjust_stock (already in later version)
create or replace function public.adjust_stock(p_product_id uuid, p_new_quantity integer, p_note text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_user uuid := auth.uid();
  v_product public.products%rowtype;
  v_diff integer;
  v_expected integer;
  v_who text;
begin
  if v_user is null or not public.is_active_user() then
    raise exception 'Your account is inactive or not signed in';
  end if;
  if p_new_quantity is null or p_new_quantity < 0 then
    raise exception 'Physical count cannot be negative';
  end if;
  select * into v_product from public.products where id = p_product_id and active = true for update;
  if not found then raise exception 'Product not found or inactive'; end if;
  v_expected := v_product.stock_qty;
  v_diff := p_new_quantity - v_expected;
  update public.products set stock_qty = p_new_quantity, updated_at = now() where id = p_product_id;
  insert into public.stock_movements(product_id, user_id, movement_type, quantity_change, quantity_after, note)
  values (
    p_product_id, v_user, 'adjustment', v_diff, p_new_quantity,
    coalesce(nullif(trim(p_note), ''), 'Inventory audit adjustment')
  );
  begin
    select coalesce(full_name, 'Staff') into v_who from public.profiles where id = v_user;
    perform public.notify_admin(
      'inventory_audit',
      'Stock audit: ' || v_product.name,
      coalesce(v_who, 'Staff') || ' audited ' || v_product.name
        || ' — expected ' || v_expected::text
        || ' → counted ' || p_new_quantity::text
        || ' (var ' || case when v_diff >= 0 then '+' else '' end || v_diff::text || ')'
    );
  exception when others then null;
  end;
  return jsonb_build_object('product_id', p_product_id, 'quantity_change', v_diff, 'stock_qty', p_new_quantity);
end;
$$;
grant execute on function public.adjust_stock(uuid, integer, text) to authenticated;

-- === Hardening pass (expenses policies idempotent) ===
drop policy if exists "expenses admin insert" on public.expenses;
drop policy if exists "expenses active insert" on public.expenses;
create policy "expenses active insert" on public.expenses
  for insert to authenticated
  with check (public.is_active_user() and created_by = auth.uid());
drop policy if exists "expenses admin read" on public.expenses;
drop policy if exists "expenses read own or admin" on public.expenses;
create policy "expenses read own or admin" on public.expenses
  for select to authenticated
  using (public.is_active_user() and (created_by = auth.uid() or public.is_admin()));

-- === v1.6.1: admin soft-delete user + PIN login hardening ===
create or replace function public.admin_delete_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can delete users';
  end if;
  if p_user_id is null then
    raise exception 'User id required';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot delete your own account';
  end if;
  select full_name into v_name from public.profiles where id = p_user_id;
  if not found then
    raise exception 'User not found';
  end if;
  -- Soft-delete: disable login; keep rows for sales/expense history FKs
  update public.profiles
  set active = false,
      pin_hash = null,
      updated_at = now()
  where id = p_user_id;
  insert into public.activity_log(user_id, action, details)
  values (auth.uid(), 'user_deleted', coalesce(v_name, p_user_id::text));
  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'full_name', v_name);
end;
$$;
grant execute on function public.admin_delete_user(uuid) to authenticated;

-- Ensure resolve_pin_login accepts both browser btoa and encode(convert_to) hashes
create or replace function public.resolve_pin_login(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text;
  v_hash2 text;
  v_count int;
  v_email text;
  v_name text;
  v_role text;
begin
  if p_pin is null or length(trim(p_pin)) < 4 then
    raise exception 'Enter a valid PIN';
  end if;
  -- Match frontend btoa(pin) and Postgres encode(convert_to(...),'base64')
  v_hash := encode(convert_to(trim(p_pin), 'UTF8'), 'base64');
  v_hash2 := encode(convert_to(trim(p_pin), 'UTF8'), 'base64'); -- same for ASCII
  select count(*) into v_count
  from public.profiles
  where active = true and (pin_hash = v_hash or pin_hash = v_hash2);
  if v_count = 0 then
    raise exception 'Invalid PIN';
  end if;
  if v_count > 1 then
    raise exception 'PIN is not unique. Ask admin to set a unique PIN.';
  end if;
  select coalesce(nullif(login_email, ''), email_from_auth), full_name, role
  into v_email, v_name, v_role
  from (
    select p.login_email, p.full_name, p.role,
           (select u.email from auth.users u where u.id = p.id) as email_from_auth
    from public.profiles p
    where p.active = true and (p.pin_hash = v_hash or p.pin_hash = v_hash2)
    limit 1
  ) x;
  if v_email is null or v_email = '' then
    raise exception 'Account has no login email. Ask admin to recreate the user.';
  end if;
  return jsonb_build_object(
    'email', v_email,
    'full_name', v_name,
    'role', v_role
  );
end;
$$;
grant execute on function public.resolve_pin_login(text) to anon, authenticated;

-- Cashiers can read their own expenses (idempotent)
drop policy if exists "expenses admin read" on public.expenses;
drop policy if exists "expenses read own or admin" on public.expenses;
create policy "expenses read own or admin" on public.expenses
  for select to authenticated
  using (public.is_active_user() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "expenses admin insert" on public.expenses;
drop policy if exists "expenses active insert" on public.expenses;
create policy "expenses active insert" on public.expenses
  for insert to authenticated
  with check (public.is_active_user() and created_by = auth.uid());

-- === v1.7 settings + secure PIN (SHA-256) ===
alter table public.app_settings add column if not exists idle_timeout_minutes integer not null default 5 check (idle_timeout_minutes between 1 and 60);
alter table public.app_settings add column if not exists block_sale_when_out boolean not null default true;
alter table public.app_settings add column if not exists show_till_on_receipt boolean not null default true;
alter table public.app_settings add column if not exists show_cashier_on_receipt boolean not null default true;

-- PIN resolve: accept SHA-256 hex (new) and legacy base64 (btoa) hashes
create or replace function public.resolve_pin_login(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash_sha text;
  v_hash_b64 text;
  v_count int;
  v_email text;
  v_name text;
  v_role text;
begin
  if p_pin is null or length(trim(p_pin)) < 4 then
    raise exception 'Enter a valid PIN';
  end if;
  v_hash_sha := encode(digest(trim(p_pin), 'sha256'), 'hex');
  v_hash_b64 := encode(convert_to(trim(p_pin), 'UTF8'), 'base64');
  select count(*) into v_count
  from public.profiles
  where active = true and (pin_hash = v_hash_sha or pin_hash = v_hash_b64);
  if v_count = 0 then
    raise exception 'Invalid PIN';
  end if;
  if v_count > 1 then
    raise exception 'PIN is not unique. Ask admin to set a unique PIN.';
  end if;
  select coalesce(nullif(login_email, ''), email_from_auth), full_name, role
  into v_email, v_name, v_role
  from (
    select p.login_email, p.full_name, p.role,
           (select u.email from auth.users u where u.id = p.id) as email_from_auth
    from public.profiles p
    where p.active = true and (p.pin_hash = v_hash_sha or p.pin_hash = v_hash_b64)
    limit 1
  ) x;
  if v_email is null or v_email = '' then
    raise exception 'Account has no login email. Ask admin to recreate the user.';
  end if;
  return jsonb_build_object(
    'email', v_email,
    'full_name', v_name,
    'role', v_role
  );
end;
$$;
grant execute on function public.resolve_pin_login(text) to anon, authenticated;

-- Clearer multi-till stock conflict message (already uses FOR UPDATE)
create or replace function public.checkout_sale(p_items jsonb, p_payment_method text, p_creditor_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_receipt text;
  v_sale_id uuid;
  v_subtotal numeric := 0;
  v_cost_total numeric := 0;
  v_total_items int := 0;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty int;
  v_line numeric;
begin
  if v_user is null or not public.is_active_user() then
    raise exception 'Your account is inactive or not signed in';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Cart is empty';
  end if;
  if p_payment_method is null or p_payment_method not in ('cash','mpesa','card','credit','other') then
    raise exception 'Invalid payment method';
  end if;
  if p_payment_method = 'credit' and (p_creditor_name is null or length(trim(p_creditor_name)) = 0) then
    raise exception 'Creditor name is required for credit sales';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_qty := greatest(1, coalesce((v_item->>'quantity')::integer, 0));
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid and active = true for update;
    if not found then raise exception 'Product not found'; end if;
    if v_product.stock_qty < v_qty then
      raise exception 'Stock changed on another till: % has only % left (you requested %). Refresh and try again.',
        v_product.name, v_product.stock_qty, v_qty;
    end if;
    v_subtotal := v_subtotal + round(v_product.sell_price * v_qty, 2);
    v_cost_total := v_cost_total + round(v_product.cost_price * v_qty, 2);
    v_total_items := v_total_items + v_qty;
  end loop;

  v_receipt := 'R' || to_char(now(), 'YYMMDD') || '-' || lpad((floor(random()*9000)+1000)::text, 4, '0');
  insert into public.sales(receipt_no, cashier_id, subtotal, total, cost_total, payment_method, creditor_name)
  values (v_receipt, v_user, v_subtotal, v_subtotal, v_cost_total, p_payment_method,
    case when p_payment_method = 'credit' then trim(p_creditor_name) else null end)
  returning id into v_sale_id;

  for v_item in select value from jsonb_array_elements(p_items) order by value->>'product_id' loop
    v_qty := greatest(1, coalesce((v_item->>'quantity')::integer, 0));
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid and active = true for update;
    if v_product.stock_qty < v_qty then
      raise exception 'Stock changed on another till: % has only % left. Sale cancelled — refresh and retry.',
        v_product.name, v_product.stock_qty;
    end if;
    v_line := round(v_product.sell_price * v_qty, 2);
    update public.products set stock_qty = stock_qty - v_qty, updated_at = now() where id = v_product.id returning * into v_product;
    insert into public.sale_items(sale_id, product_id, product_name, quantity, unit_cost, unit_price, line_total)
    values (v_sale_id, v_product.id, v_product.name, v_qty, v_product.cost_price, v_product.sell_price, v_line);
    insert into public.stock_movements(product_id, user_id, movement_type, quantity_change, quantity_after, note, reference_id)
    values (v_product.id, v_user, 'sale', -v_qty, v_product.stock_qty, 'Sale '||v_receipt, v_sale_id);
  end loop;

  return jsonb_build_object('id', v_sale_id, 'receipt_no', v_receipt, 'total', v_subtotal, 'cost_total', v_cost_total, 'item_count', v_total_items);
end;
$$;
grant execute on function public.checkout_sale(jsonb, text, text) to authenticated;

-- === PIN login reliability (v1.7.2) ===
-- Re-apply resolve_pin_login for SHA-256 + legacy base64
create extension if not exists pgcrypto;

create or replace function public.resolve_pin_login(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash_sha text;
  v_hash_b64 text;
  v_count int;
  v_email text;
  v_name text;
  v_role text;
begin
  if p_pin is null or length(trim(p_pin)) < 4 then
    raise exception 'Enter a valid PIN';
  end if;
  v_hash_sha := encode(digest(trim(p_pin), 'sha256'), 'hex');
  v_hash_b64 := encode(convert_to(trim(p_pin), 'UTF8'), 'base64');
  select count(*) into v_count
  from public.profiles
  where active = true and pin_hash is not null
    and (pin_hash = v_hash_sha or pin_hash = v_hash_b64);
  if v_count = 0 then
    raise exception 'Invalid PIN';
  end if;
  if v_count > 1 then
    raise exception 'PIN is not unique. Ask admin to set a unique PIN.';
  end if;
  select coalesce(nullif(login_email, ''), email_from_auth), full_name, role
  into v_email, v_name, v_role
  from (
    select p.login_email, p.full_name, p.role,
           (select u.email from auth.users u where u.id = p.id) as email_from_auth
    from public.profiles p
    where p.active = true and pin_hash is not null
      and (p.pin_hash = v_hash_sha or p.pin_hash = v_hash_b64)
    limit 1
  ) x;
  if v_email is null or v_email = '' then
    raise exception 'Account has no login email. Ask admin to recreate the user.';
  end if;
  return jsonb_build_object(
    'email', v_email,
    'full_name', v_name,
    'role', v_role
  );
end;
$$;
grant execute on function public.resolve_pin_login(text) to anon, authenticated;

-- Allow anonymous execute (login screen before session)
revoke all on function public.resolve_pin_login(text) from public;
grant execute on function public.resolve_pin_login(text) to anon, authenticated;

-- Thermal receipt paper width (58 or 80 mm)
alter table public.app_settings add column if not exists receipt_paper_mm integer not null default 80;

-- =============================================================================
-- END OF SCHEMA — run this entire file in Supabase → SQL Editor (safe to re-run)
-- Includes: tables, RLS, checkout_sale, resolve_pin_login (PIN login),
-- admin_delete_user, idle_timeout_minutes, block_sale_when_out,
-- show_till/cashier on receipt, receipt_paper_mm (58/80 thermal).
-- =============================================================================

-- =============================================================================
-- FIX: digest(text, unknown) does not exist
-- Use digest(bytea, text) via convert_to — works on all Supabase Postgres builds
-- Run this block in SQL Editor if PIN login shows the digest error.
-- =============================================================================
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pgcrypto;

create or replace function public.resolve_pin_login(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash_sha text;
  v_hash_b64 text;
  v_count int;
  v_email text;
  v_name text;
  v_role text;
  v_pin text := trim(p_pin);
begin
  if v_pin is null or length(v_pin) < 4 then
    raise exception 'Enter a valid PIN';
  end if;

  -- SHA-256 hex (matches Web Crypto in the app)
  v_hash_sha := encode(
    extensions.digest(convert_to(v_pin, 'UTF8'), 'sha256'::text),
    'hex'
  );
  -- Legacy browser btoa / encode base64
  v_hash_b64 := encode(convert_to(v_pin, 'UTF8'), 'base64');

  select count(*) into v_count
  from public.profiles
  where active = true
    and pin_hash is not null
    and (pin_hash = v_hash_sha or pin_hash = v_hash_b64);

  if v_count = 0 then
    raise exception 'Invalid PIN';
  end if;
  if v_count > 1 then
    raise exception 'PIN is not unique. Ask admin to set a unique PIN.';
  end if;

  select coalesce(nullif(login_email, ''), email_from_auth), full_name, role
  into v_email, v_name, v_role
  from (
    select p.login_email, p.full_name, p.role,
           (select u.email from auth.users u where u.id = p.id) as email_from_auth
    from public.profiles p
    where p.active = true
      and p.pin_hash is not null
      and (p.pin_hash = v_hash_sha or p.pin_hash = v_hash_b64)
    limit 1
  ) x;

  if v_email is null or v_email = '' then
    raise exception 'Account has no login email. Ask admin to recreate the user.';
  end if;

  return jsonb_build_object(
    'email', v_email,
    'full_name', v_name,
    'role', v_role
  );
end;
$$;

grant execute on function public.resolve_pin_login(text) to anon, authenticated;
revoke all on function public.resolve_pin_login(text) from public;
grant execute on function public.resolve_pin_login(text) to anon, authenticated;

-- Factory reset: FULL wipe of business data.
-- Keeps auth users + profiles so admin can still log in.
-- Returns jsonb counts so the app can verify the wipe actually ran.
create or replace function public.factory_reset()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_sale_items int := 0;
  n_sales int := 0;
  n_credit_payments int := 0;
  n_expenses int := 0;
  n_stock_movements int := 0;
  n_stock_receipts int := 0;
  n_products int := 0;
  n_suppliers int := 0;
  n_notifications int := 0;
  n_activity int := 0;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if not public.is_admin() then
    raise exception 'Only admin can factory reset';
  end if;

  select count(*) into n_sale_items from public.sale_items;
  select count(*) into n_sales from public.sales;
  select count(*) into n_credit_payments from public.credit_payments;
  select count(*) into n_expenses from public.expenses;
  select count(*) into n_stock_movements from public.stock_movements;
  select count(*) into n_stock_receipts from public.stock_receipts;
  select count(*) into n_products from public.products;
  select count(*) into n_suppliers from public.suppliers;
  select count(*) into n_notifications from public.admin_notifications;
  select count(*) into n_activity from public.activity_log;

  -- Hard delete (order respects FKs)
  delete from public.sale_items;
  delete from public.sales;
  delete from public.credit_payments;
  delete from public.expenses;
  delete from public.stock_movements;
  delete from public.stock_receipts;
  delete from public.products;
  delete from public.suppliers;
  delete from public.admin_notifications;
  delete from public.activity_log;

  -- Soft-clear branding fields; keep settings row so app still loads
  update public.app_settings
  set
    logo_url = null,
    till_number = null,
    receipt_footer = 'Thank you!',
    updated_at = now()
  where id = 1;

  insert into public.activity_log(user_id, action, details)
  values (
    auth.uid(),
    'factory_reset',
    format(
      'Full wipe: products=%s sales=%s expenses=%s suppliers=%s',
      n_products, n_sales, n_expenses, n_suppliers
    )
  );

  return jsonb_build_object(
    'ok', true,
    'sale_items', n_sale_items,
    'sales', n_sales,
    'credit_payments', n_credit_payments,
    'expenses', n_expenses,
    'stock_movements', n_stock_movements,
    'stock_receipts', n_stock_receipts,
    'products', n_products,
    'suppliers', n_suppliers,
    'admin_notifications', n_notifications,
    'activity_log', n_activity
  );
end;
$$;

grant execute on function public.factory_reset() to authenticated;


-- Factory reset: wipe business data (WHERE true for safeupdate)
create or replace function public.factory_reset()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_sale_items int := 0;
  n_sales int := 0;
  n_credit_payments int := 0;
  n_expenses int := 0;
  n_stock_movements int := 0;
  n_stock_receipts int := 0;
  n_products int := 0;
  n_suppliers int := 0;
  n_notifications int := 0;
  n_activity int := 0;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if not public.is_admin() then
    raise exception 'Only admin can factory reset';
  end if;

  select count(*) into n_sale_items from public.sale_items;
  select count(*) into n_sales from public.sales;
  select count(*) into n_credit_payments from public.credit_payments;
  select count(*) into n_expenses from public.expenses;
  select count(*) into n_stock_movements from public.stock_movements;
  select count(*) into n_stock_receipts from public.stock_receipts;
  select count(*) into n_products from public.products;
  select count(*) into n_suppliers from public.suppliers;
  select count(*) into n_notifications from public.admin_notifications;
  select count(*) into n_activity from public.activity_log;

  delete from public.sale_items where true;
  delete from public.sales where true;
  delete from public.credit_payments where true;
  delete from public.expenses where true;
  delete from public.stock_movements where true;
  delete from public.stock_receipts where true;
  delete from public.products where true;
  delete from public.suppliers where true;
  delete from public.admin_notifications where true;
  delete from public.activity_log where true;

  update public.app_settings
  set logo_url = null, till_number = null, receipt_footer = 'Thank you!', updated_at = now()
  where id = 1;

  insert into public.activity_log(user_id, action, details)
  values (
    auth.uid(),
    'factory_reset',
    format('Full wipe: products=%s sales=%s expenses=%s suppliers=%s', n_products, n_sales, n_expenses, n_suppliers)
  );

  return jsonb_build_object(
    'ok', true,
    'sale_items', n_sale_items,
    'sales', n_sales,
    'credit_payments', n_credit_payments,
    'expenses', n_expenses,
    'stock_movements', n_stock_movements,
    'stock_receipts', n_stock_receipts,
    'products', n_products,
    'suppliers', n_suppliers,
    'admin_notifications', n_notifications,
    'activity_log', n_activity
  );
end;
$$;
grant execute on function public.factory_reset() to authenticated;
