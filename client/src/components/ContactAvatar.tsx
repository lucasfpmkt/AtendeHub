import { useState } from 'react';
import { api } from '../api';

/**
 * Avatar do contato: foto de perfil do WhatsApp quando existe; senão, as iniciais
 * (também se a imagem falhar ao carregar).
 */
export function ContactAvatar({
  contact,
  label,
  className = 'avatar',
  style,
}: {
  contact?: { id: string; avatarUrl?: string | null } | null;
  label: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const src = api.avatarSrc(contact);
  const [failed, setFailed] = useState<string | null>(null);
  if (src && failed !== src) {
    return (
      <span className={`${className} has-photo`} style={style}>
        <img src={src} alt="" loading="lazy" onError={() => setFailed(src)} />
      </span>
    );
  }
  return (
    <span className={className} style={style}>
      {label}
    </span>
  );
}
