export const errorTranslations: Record<string, string> = {
  // Authentication errors
  'Invalid login or password': 'Неверный логин или пароль',
  'Login and password required': 'Необходимо указать логин и пароль',
  'Login already taken': 'Логин уже занят',
  'Invite required': 'Требуется инвайт',
  'Invalid invite': 'Неверный инвайт',
  'Invite expired': 'Срок действия инвайта истёк',
  'Invite limit reached': 'Достигнут лимит использования инвайта',
  'Password must be a non-empty string': 'Пароль должен быть непустой строкой',
  'Login must be 2-32 characters long and contain only letters and numbers': 'Логин должен быть длиной 2-32 символа и содержать только буквы и цифры',
  'Account verification required': 'Требуется подтверждение аккаунта',
  'Account pending verification': 'Аккаунт ожидает подтверждения',
  'Account is already verified': 'Аккаунт уже подтверждён',
  'Comment must be a string': 'Комментарий должен быть строкой',
  'Comment must not exceed 500 characters': 'Комментарий не должен превышать 500 символов',
  'Invalid or expired code': 'Неверный или просроченный код',
  'Code has expired': 'Срок действия кода истёк',
  'Code already exists': 'Такой код уже существует',
  'Too many verification attempts. Try again later.':
    'Слишком много попыток верификации. Попробуйте позже.',
  'Verification system is disabled': 'Система верификации отключена',
  'userId required': 'Не указан пользователь',
  'User not found or already verified': 'Пользователь не найден или уже подтверждён',
  
  // Generic errors
  'Ошибка входа': 'Ошибка входа',
  'Ошибка регистрации': 'Ошибка регистрации',
  'HTTP 400': 'Некорректный запрос',
  'HTTP 401': 'Неавторизованный доступ',
  'HTTP 403': 'Доступ запрещён',
  'HTTP 404': 'Страница не найдена',
  'HTTP 500': 'Внутренняя ошибка сервера',
  
  // Network errors
  'Network error': 'Ошибка сети',
  
  // Room-related errors
  'Room name required': 'Название комнаты обязательно',
  'Room name cannot be empty': 'Название комнаты не может быть пустым',
  'Room name cannot exceed 15 characters': 'Название комнаты не может превышать 15 символов',
  'Room with this name already exists': 'Комната с таким названием уже существует',
  'Main room cannot be renamed': 'Основную комнату нельзя переименовать',
  'Main room cannot be deleted': 'Основную комнату нельзя удалить',
  'Room not found': 'Комната не найдена',
  'Only owner or moderator can perform this action': 'Только владелец или модератор может выполнить это действие',
};