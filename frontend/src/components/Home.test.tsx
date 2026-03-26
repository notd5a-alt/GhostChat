import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Home from './Home';

describe('Home', () => {
  it('renders create room and join options', () => {
    render(<Home onCreateRoom={vi.fn()} onJoinRoom={vi.fn()} roomError={null} themeId="default" onThemeChange={vi.fn()} />);
    expect(screen.getByText('Create Room')).toBeInTheDocument();
    expect(screen.getByText('[ JOIN ]')).toBeInTheDocument();
  });

  it('calls onCreateRoom when create button is clicked', async () => {
    const onCreateRoom = vi.fn();
    render(<Home onCreateRoom={onCreateRoom} onJoinRoom={vi.fn()} roomError={null} themeId="default" onThemeChange={vi.fn()} />);
    await userEvent.click(screen.getByText('Create Room'));
    expect(onCreateRoom).toHaveBeenCalledTimes(1);
  });

  it('calls onJoinRoom with code when form is submitted', async () => {
    const onJoinRoom = vi.fn();
    render(<Home onCreateRoom={vi.fn()} onJoinRoom={onJoinRoom} roomError={null} themeId="default" onThemeChange={vi.fn()} />);

    const input = screen.getByPlaceholderText('Enter room code');
    await userEvent.type(input, 'X7KM3P');
    await userEvent.click(screen.getByText('[ JOIN ]'));

    expect(onJoinRoom).toHaveBeenCalledWith('X7KM3P');
  });

  it('disables join button when code is empty', () => {
    render(<Home onCreateRoom={vi.fn()} onJoinRoom={vi.fn()} roomError={null} themeId="default" onThemeChange={vi.fn()} />);
    const joinBtn = screen.getByText('[ JOIN ]');
    expect(joinBtn).toBeDisabled();
  });

  it('shows room error when present', () => {
    render(<Home onCreateRoom={vi.fn()} onJoinRoom={vi.fn()} roomError="Room not found." themeId="default" onThemeChange={vi.fn()} />);
    expect(screen.getByText('Room not found.')).toBeInTheDocument();
  });

  it('shows server settings toggle', () => {
    render(<Home onCreateRoom={vi.fn()} onJoinRoom={vi.fn()} roomError={null} themeId="default" onThemeChange={vi.fn()} />);
    expect(screen.getByText('[ SERVER ]')).toBeInTheDocument();
  });

  it('toggles server settings panel', async () => {
    render(<Home onCreateRoom={vi.fn()} onJoinRoom={vi.fn()} roomError={null} themeId="default" onThemeChange={vi.fn()} />);
    await userEvent.click(screen.getByText('[ SERVER ]'));
    expect(screen.getByText('LOCAL')).toBeInTheDocument();
    expect(screen.getByText('REMOTE')).toBeInTheDocument();
  });
});
