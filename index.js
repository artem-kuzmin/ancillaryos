require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.catch((err) => console.log('Ошибка бота:', err.message));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const carts = {};
const conversations = {};

// ============ КОМАНДЫ ХОСТА ============

bot.command('addproperty', async (ctx) => {
  const parts = ctx.message.text.replace('/addproperty ', '').split('|').map(s => s.trim());
  if (parts.length < 2) return ctx.reply('Формат: /addproperty Название | Адрес');

  const { data, error } = await supabase.from('properties').insert({
    pm_telegram_id: ctx.from.id, name: parts[0], address: parts[1]
  }).select().single();

  if (error) return ctx.reply('Ошибка: ' + error.message);
  ctx.reply(`✅ Объект добавлен: ${data.name}\n\nТеперь добавьте услуги — отправьте /templates чтобы добавить готовый набор из 10 популярных услуг.`);
});

bot.command('myproperties', async (ctx) => {
  const { data } = await supabase.from('properties').select('id, name, address').eq('pm_telegram_id', ctx.from.id);
  if (!data || data.length === 0) return ctx.reply('Объектов пока нет. Добавьте: /addproperty');
  const list = data.map((p, i) => `${i + 1}. ${p.name}\n   ${p.address}\n   ID: ${p.id}`).join('\n\n');
  ctx.reply(`Ваши объекты:\n\n${list}`);
});

bot.command('addancillary', async (ctx) => {
  const parts = ctx.message.text.replace('/addancillary ', '').split('|').map(s => s.trim());
  if (parts.length < 4) return ctx.reply('Формат: /addancillary ID_объекта | Название услуги | цена_будни | цена_выходные');

  const { data, error } = await supabase.from('ancillaries').insert({
    property_id: parts[0], name: parts[1], price_weekday: parseInt(parts[2]), price_weekend: parseInt(parts[3])
  }).select().single();

  if (error) return ctx.reply('Ошибка: ' + error.message);
  ctx.reply(`✅ Услуга добавлена: ${data.name} (₽${data.price_weekday} будни / ₽${data.price_weekend} выходные)`);
});

bot.command('newbooking', async (ctx) => {
  const { data: properties } = await supabase.from('properties').select('id, name').eq('pm_telegram_id', ctx.from.id);
  if (!properties || properties.length === 0) return ctx.reply('Сначала добавьте объект: /addproperty');

  if (properties.length === 1) {
    conversations[ctx.from.id] = { step: 'guest_name', propertyId: properties[0].id, propertyName: properties[0].name };
    return ctx.reply(`Объект: *${properties[0].name}*\n\nВведите имя гостя:`, { parse_mode: 'Markdown' });
  }

  conversations[ctx.from.id] = { step: 'choose_property' };
  carts[`props_nb_${ctx.from.id}`] = properties;
  const buttons = properties.map(p => [Markup.button.callback(p.name, `nb_${p.id.slice(0, 8)}`)]);
  ctx.reply('Выберите объект:', Markup.inlineKeyboard(buttons));
});

bot.command('revenue', async (ctx) => {
  const { data: properties } = await supabase.from('properties').select('id').eq('pm_telegram_id', ctx.from.id);
  if (!properties || properties.length === 0) return ctx.reply('Объектов пока нет.');

  const propertyIds = properties.map(p => p.id);
  const { data: purchases } = await supabase.from('purchases')
    .select('price_paid, status, booking_id, bookings!inner(property_id)')
    .eq('status', 'paid').in('bookings.property_id', propertyIds);

  const total = (purchases || []).reduce((sum, p) => sum + p.price_paid, 0);
  const platformFee = Math.round(total * 0.1);
  ctx.reply(`💰 Сводка по доходам\n\nВсего продаж: ₽${total.toLocaleString()}\nКомиссия платформы (10%): ₽${platformFee.toLocaleString()}\nВаш доход: ₽${(total - platformFee).toLocaleString()}\nПокупок: ${(purchases || []).length}`);
});

// Шаблоны услуг
const TEMPLATES = [
  { name: 'Ранний заезд (с 10:00)', price_weekday: 1500, price_weekend: 2000 },
  { name: 'Поздний выезд (до 18:00)', price_weekday: 1500, price_weekend: 2500 },
  { name: 'Дополнительная уборка', price_weekday: 2000, price_weekend: 2000 },
  { name: 'Пакет продуктов к заезду', price_weekday: 2500, price_weekend: 2500 },
  { name: 'Праздничный декор', price_weekday: 3000, price_weekend: 3500 },
  { name: 'Парковочное место', price_weekday: 500, price_weekend: 500 },
  { name: 'Комплект полотенец', price_weekday: 500, price_weekend: 500 },
  { name: 'Аренда детской кроватки', price_weekday: 800, price_weekend: 800 },
  { name: 'Трансфер из аэропорта', price_weekday: 3000, price_weekend: 3000 },
  { name: 'Размещение с питомцем', price_weekday: 1000, price_weekend: 1000 },
];

bot.command('templates', async (ctx) => {
  const { data: properties } = await supabase.from('properties').select('id, name').eq('pm_telegram_id', ctx.from.id);
  if (!properties || properties.length === 0) return ctx.reply('Сначала добавьте объект: /addproperty');

  carts[`props_${ctx.from.id}`] = properties;
  const buttons = properties.map(p => [Markup.button.callback(p.name, `tpl_${p.id.slice(0, 8)}`)]);
  ctx.reply('Выберите объект, для которого добавить шаблоны услуг:', Markup.inlineKeyboard(buttons));
});

// ============ CALLBACK ACTIONS ============

bot.action(/nb_(.+)/, async (ctx) => {
  const shortId = ctx.match[1];
  const properties = carts[`props_nb_${ctx.from.id}`];
  if (!properties) return ctx.reply('Сессия истекла. Отправьте /newbooking заново.');
  const property = properties.find(p => p.id.startsWith(shortId));
  if (!property) return ctx.reply('Объект не найден.');

  conversations[ctx.from.id] = { step: 'guest_name', propertyId: property.id, propertyName: property.name };
  ctx.answerCbQuery();
  ctx.editMessageText(`Объект: *${property.name}*\n\nВведите имя гостя:`, { parse_mode: 'Markdown' });
});

bot.action(/tpl_(.+)/, async (ctx) => {
  const shortId = ctx.match[1];
  const properties = carts[`props_${ctx.from.id}`];
  if (!properties) return ctx.reply('Сессия истекла. Отправьте /templates заново.');
  const property = properties.find(p => p.id.startsWith(shortId));
  if (!property) return ctx.reply('Объект не найден.');

  const rows = TEMPLATES.map(t => ({ property_id: property.id, name: t.name, price_weekday: t.price_weekday, price_weekend: t.price_weekend }));
  const { error } = await supabase.from('ancillaries').insert(rows);
  if (error) return ctx.reply('Ошибка: ' + error.message);

  ctx.answerCbQuery();
  const list = TEMPLATES.map(t => `• ${t.name} — ₽${t.price_weekday} / ₽${t.price_weekend}`).join('\n');
  ctx.editMessageText(`✅ Добавлено ${TEMPLATES.length} услуг для *${property.name}*:\n\n${list}\n\nЦены можно изменить: /editprices`, { parse_mode: 'Markdown' });
});

bot.action(/buy_(\d+)_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1]);
  const price = parseInt(ctx.match[2]);
  const cart = carts[ctx.from.id.toString()];
  if (!cart) return ctx.reply('Сессия истекла. Перейдите по ссылке от хоста заново.');

  const ancillary = cart.ancillaries[index];
  ctx.answerCbQuery();
  ctx.reply(`Вы выбрали: *${ancillary.name}* — ₽${price.toLocaleString()}\n\nПодтвердить покупку?`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Подтвердить', `ok_${index}_${price}`)],
      [Markup.button.callback('❌ Отмена', 'cancel')]
    ])
  });
});

bot.action(/ok_(\d+)_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1]);
  const price = parseInt(ctx.match[2]);
  const cart = carts[ctx.from.id.toString()];
  if (!cart) return ctx.reply('Сессия истекла. Перейдите по ссылке от хоста заново.');

  const ancillary = cart.ancillaries[index];
  const { error } = await supabase.from('purchases').insert({
    booking_id: cart.bookingId, ancillary_id: ancillary.id, price_paid: price, status: 'paid'
  });
  if (error) return ctx.reply('Что-то пошло не так. Попробуйте ещё раз.');

  ctx.answerCbQuery();
  ctx.editMessageText(`✅ Подтверждено! *${ancillary.name}* забронирована.\n\nВаш хост уведомлён.`, { parse_mode: 'Markdown' });

  const { data: booking } = await supabase.from('bookings')
    .select('guest_name, properties(pm_telegram_id, name)').eq('id', cart.bookingId).single();
  if (booking) {
    bot.telegram.sendMessage(booking.properties.pm_telegram_id,
      `🔔 Новая покупка!\n\nГость: ${booking.guest_name}\nОбъект: ${booking.properties.name}\nУслуга: ${ancillary.name}\nСумма: ₽${price.toLocaleString()}`);
  }
});

bot.action('cancel', (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText('Отменено. Вы всегда можете добавить услуги позже!');
});

// ============ ГОСТЕВОЙ ФЛОУ ============

bot.start(async (ctx) => {
  const payload = ctx.startPayload;

  if (!payload || !payload.startsWith('b_')) {
    return ctx.reply('👋 Добро пожаловать!\n\nЕсли вы хост — используйте /addproperty чтобы начать.\n\nЕсли вы гость — перейдите по ссылке, которую прислал ваш хост.');
  }

  const bookingId = payload.replace('b_', '');
  const { data: booking } = await supabase.from('bookings')
    .select('*, properties(name, address, checkin_time, checkout_time)').eq('id', bookingId).single();

  if (!booking) return ctx.reply('Бронирование не найдено. Свяжитесь с хостом.');

  await supabase.from('bookings').update({ guest_telegram_id: ctx.from.id }).eq('id', bookingId);

  const checkinDay = new Date(booking.checkin_date).getDay();
  const isWeekend = checkinDay === 5 || checkinDay === 6 || checkinDay === 0;

  const { data: ancillaries } = await supabase.from('ancillaries')
    .select('*').eq('property_id', booking.property_id).eq('is_active', true);

  if (!ancillaries || ancillaries.length === 0) {
    return ctx.reply(`Добро пожаловать в ${booking.properties.name}! 🏠\nДополнительных услуг пока нет.`);
  }

  carts[ctx.from.id.toString()] = { ancillaries, bookingId };

  const buttons = ancillaries.map((a, i) => {
    const price = isWeekend ? a.price_weekend : a.price_weekday;
    return [Markup.button.callback(`${a.name} — ₽${price.toLocaleString()}`, `buy_${i}_${price}`)];
  });

  ctx.reply(
    `Добро пожаловать! 🏠 Ваше проживание в *${booking.properties.name}* скоро начнётся.\n\n` +
    `📅 Заезд: ${booking.checkin_date} в ${booking.properties.checkin_time}\n` +
    `📅 Выезд: ${booking.checkout_date} в ${booking.properties.checkout_time}\n\n` +
    `Сделайте ваш отдых комфортнее:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
});

// Пошаговый ввод — ДОЛЖЕН БЫТЬ ПОСЛЕДНИМ
bot.on('text', async (ctx) => {
  const conv = conversations[ctx.from.id];
  if (!conv) return;

  const text = ctx.message.text;
  if (text.startsWith('/')) { delete conversations[ctx.from.id]; return; }

  if (conv.step === 'guest_name') {
    conv.guestName = text;
    conv.step = 'checkin_date';
    return ctx.reply(`Гость: *${text}*\n\nВведите дату заезда (ГГГГ-ММ-ДД, например 2026-05-01 = 1 мая):`, { parse_mode: 'Markdown' });
  }
  if (conv.step === 'checkin_date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return ctx.reply('Неверный формат. Введите дату как: 2026-05-01');
    conv.checkinDate = text;
    conv.step = 'checkout_date';
    return ctx.reply(`Заезд: *${text}*\n\nВведите дату выезда (ГГГГ-ММ-ДД):`, { parse_mode: 'Markdown' });
  }
  if (conv.step === 'checkout_date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return ctx.reply('Неверный формат. Введите дату как: 2026-05-05');

    const { data, error } = await supabase.from('bookings').insert({
      property_id: conv.propertyId, guest_name: conv.guestName, checkin_date: conv.checkinDate, checkout_date: text
    }).select().single();
    delete conversations[ctx.from.id];

    if (error) return ctx.reply('Ошибка: ' + error.message);
    const guestLink = `https://t.me/${(await bot.telegram.getMe()).username}?start=b_${data.id}`;
    ctx.reply(`✅ Бронирование создано\n\n🏠 ${conv.propertyName}\n👤 ${conv.guestName}\n📅 ${conv.checkinDate} → ${text}\n\n📎 Ссылка для гостя:\n${guestLink}`);
  }
});

// ============ ЗАПУСК ============

const app_express = express();
const PORT = process.env.PORT || 3000;
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN;

if (RAILWAY_URL) {
  const webhookUrl = `https://${RAILWAY_URL}/bot`;
  app_express.use('/bot', express.json(), async (req, res) => {
    try {
      await bot.handleUpdate(req.body);
      res.sendStatus(200);
    } catch (err) {
      console.log('Ошибка:', err.message);
      res.sendStatus(200);
    }
  });
  app_express.get('/', (req, res) => res.send('AncillaryOS работает'));
  app_express.listen(PORT, async () => {
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`🤖 Бот запущен на webhook: ${webhookUrl}`);
  });
} else {
  bot.launch({ dropPendingUpdates: true });
  console.log('🤖 Бот запущен локально (polling)');
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));