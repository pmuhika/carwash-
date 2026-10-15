-- Factory reset (admin only)
-- Uses WHERE clauses so Postgres "safeupdate" does not block DELETE.
-- Run this entire file in Supabase → SQL Editor, then use Factory reset in the app.

drop function if exists public.factory_reset();

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

  -- Explicit WHERE true satisfies safeupdate / "DELETE requires a WHERE clause"
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
