'use client';

import { Heart } from 'lucide-react';
import { Card, cx } from '@/components/ui';

// Ссылки открываются в системном браузере (setWindowOpenHandler в main-процессе)
export const NOWPAYMENTS_URL = 'https://nowpayments.io/donation?api_key=b6523898-3a58-4700-8b68-0cba37e29236';
export const YANDEX_TIPS_URL = 'https://tips.yandex.ru/guest/payment/3375177';

// Обе кнопки — в пропорциях SVG NOWPayments (347.5×107.8, скругление ~16% высоты), чтобы стояли ровно
const BUTTON_ASPECT = 'aspect-[347.5/107.8]';

function NowPaymentsButton({ className }: { className?: string }) {
  return (
    <a href={NOWPAYMENTS_URL} target="_blank" rel="noreferrer noopener" className={cx('block transition hover:brightness-110', BUTTON_ASPECT, className)}>
      <img src="/nowpayments-donate.svg" alt="Cryptocurrency & Bitcoin donation button by NOWPayments" className="block h-full w-full" />
    </a>
  );
}

function YandexTipsButton({ className }: { className?: string }) {
  return (
    <a
      href={YANDEX_TIPS_URL}
      target="_blank"
      rel="noreferrer noopener"
      className={cx('flex items-center justify-center gap-2 rounded-[9px] bg-[#ffcc00] text-[14px] font-semibold text-[#1a1a1a] transition hover:brightness-105', BUTTON_ASPECT, className)}
    >
      <span className="grid size-6 place-items-center rounded-full bg-[#fc3f1d] text-[13px] font-bold text-white">Я</span>
      Яндекс Чаевые
    </a>
  );
}

export function DonateCard({ className }: { className?: string }) {
  return (
    <Card className={className} title={<span className="flex items-center gap-2"><Heart className="size-4 text-bad" />Поддержать проект</span>} subtitle="Если приложение помогает — можно отблагодарить разработчика криптовалютой или через Яндекс Чаевые.">
      <div className="flex flex-wrap items-center gap-4">
        <NowPaymentsButton className="w-[190px]" />
        <YandexTipsButton className="w-[190px]" />
      </div>
    </Card>
  );
}

export function DonateCompact() {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[12px] text-muted"><Heart className="size-3.5 text-bad" />Поддержать проект</div>
      <NowPaymentsButton className="w-full" />
      <YandexTipsButton className="w-full" />
    </div>
  );
}
